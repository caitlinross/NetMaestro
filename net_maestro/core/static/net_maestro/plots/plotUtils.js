/**
 * Shared utilities for Plotly plot components.
 * Centralizes common patterns for layout, initialization, and synchronization.
 *
 * NOTE: The synchronization code (setupXYSyncWatchers, setupParallelSyncWatchers, handleRelayout)
 * currently only supports simulation plots. When multiple event or model plots are added, the
 * synchronization system will need to be extended to support syncing within each plot type
 * (model plots with model plots, event plots with event plots, etc.).
 */
import Plotly from 'plotly';

// How a dataset's time column is turned into something readable. The FFW model
// reports virtual time in nanoseconds, and its fluid interval is one second, so
// seconds are the unit the run was configured in and the one to show. ROSS
// virtual time is model-defined, so it is left as it comes.
export const SECONDS_FROM_NS = { scale: 1e-9, suffix: ' s' };
export const RAW_TIME = { scale: 1, suffix: '' };

/**
 * Dark theme layout configuration for Plotly plots.
 */
export const DARK_LAYOUT = {
  // biome-ignore-start lint/style/useNamingConvention: Plotly layout API requires snake_case keys
  paper_bgcolor: '#1d232a',
  plot_bgcolor: '#1d232a',
  // biome-ignore-end lint/style/useNamingConvention: Plotly layout API requires snake_case keys
  font: {
    color: 'white',
  },
  margin: {
    l: 50,
    r: 50,
    b: 50,
    t: 50,
    pad: 4,
  },
};

/**
 * Creates an axis configuration with title and styling.
 * @param {string} title - Axis title text
 * @param {Object} options - Additional axis options
 * @returns {Object} Plotly axis configuration
 */
export function axisConfig(title, options = {}) {
  return {
    title: {
      text: title,
    },
    color: 'white',
    ...options,
  };
}

/**
 * Sets up a plot with standard configuration.
 * @param {Object} options - Configuration options
 * @param {Object} options.component - Component instance
 * @param {string} options.elementId - DOM element ID for the plot
 * @param {string} options.elementProp - Property name storing the element reference
 * @param {Array} options.data - Plotly data array
 * @param {Object} options.layout - Plotly layout configuration
 * @param {Array} options.eventHandlers - Array of {event, handler} objects
 */
export function setupPlot({ component, elementId, elementProp, data, layout, eventHandlers = [] }) {
  if (component.isPlotInitialized) {
    return;
  }
  const el = document.getElementById(elementId);
  if (!el) {
    return;
  }
  component[elementProp] = el;

  const config = { responsive: true };
  Plotly.newPlot(el, data, layout, config);
  component.isPlotInitialized = true;

  for (const { event, handler } of eventHandlers) {
    el.on(event, handler);
  }
}

/**
 * Purges a plot and resets initialization state.
 * @param {Object} component - Component instance
 * @param {string} elementProp - Property name storing the element reference
 */
export function purgePlot(component, elementProp) {
  const el = component[elementProp];
  if (el) {
    Plotly.purge(el);
    component.isPlotInitialized = false;
  }
}

/**
 * Sets up axis state persistence using uiStateStore.
 * @param {Object} component - Component instance
 * @param {string} plotName - Name of the plot for state key
 * @param {Array} axisConfigs - Array of {prop, default} objects
 */
export function setupAxisState(component, plotName, axisConfigs) {
  const savedState = component.$store.uiStateStore.getUIState(plotName);
  for (const { prop, default: defaultValue } of axisConfigs) {
    component[prop] = savedState[prop] ?? defaultValue;
    component.$watch(prop, (newValue) => {
      if (newValue) {
        component.$store.uiStateStore.saveUIState(plotName, { [prop]: newValue });
      }
    });
  }
}

/**
 * Sets up a watcher for dataStore.loadTick to trigger data loading.
 * @param {Object} component - Component instance
 * @param {Function} loadFn - Function to call when loadTick changes
 */
export function setupLoadWatcher(component, loadFn) {
  // Load data if a run is already selected
  if (component.$store.dataStore.selectedRunId) {
    loadFn();
  }
  // Watch for new data loads
  component.$watch('$store.dataStore.loadTick', () => {
    loadFn();
  });
}

/**
 * Handles plotly_relayout events for X/Y axis synchronization.
 * @param {Object} component - Component instance
 * @param {Object} eventData - Plotly relayout event data
 * @param {Function} getXAxis - Function returning current X axis key
 * @param {Function} getYAxis - Function returning current Y axis key
 */
export function handleRelayout(component, eventData, getXAxis, getYAxis) {
  if (component.isSyncing) {
    return;
  }
  const sync = component.$store.plotSyncStore;

  // Detect double-click reset
  if (eventData['xaxis.autorange'] || eventData['yaxis.autorange']) {
    sync.resetAll(component.plotId);
    return;
  }

  const updates = _collectRangeUpdates(eventData, getXAxis, getYAxis);
  if (updates.length > 0) {
    sync.updateRanges(updates, component.plotId);
  }
}

/**
 * Collects range updates from relayout event data.
 * @param {Object} eventData - Relayout event data
 * @param {Function} getXAxis - Function returning current X axis key
 * @param {Function} getYAxis - Function returning current Y axis key
 * @returns {Array} Array of {parameter, range} objects
 */
function _collectRangeUpdates(eventData, getXAxis, getYAxis) {
  const updates = [];
  if (eventData['xaxis.range[0]'] != null) {
    updates.push({
      parameter: getXAxis(),
      range: { min: eventData['xaxis.range[0]'], max: eventData['xaxis.range[1]'] },
    });
  }
  if (eventData['yaxis.range[0]'] != null) {
    updates.push({
      parameter: getYAxis(),
      range: { min: eventData['yaxis.range[0]'], max: eventData['yaxis.range[1]'] },
    });
  }
  return updates;
}

/**
 * Sets up X/Y axis synchronization watchers.
 * @param {Object} component - Component instance
 * @param {string} elementProp - Property name storing the element reference
 * @param {Function} getXAxis - Function returning current X axis key
 * @param {Function} getYAxis - Function returning current Y axis key
 */
export function setupXYSyncWatchers(component, elementProp, getXAxis, getYAxis) {
  const sync = component.$store.plotSyncStore;

  // Watch for range changes from other plots
  component.$watch('$store.plotSyncStore.parameterRanges', (ranges) => {
    if (sync.lastUpdatedBy === component.plotId) {
      return;
    }
    const xRange = ranges[getXAxis()];
    const yRange = ranges[getYAxis()];
    if (!(xRange || yRange)) {
      return;
    }
    _applySyncedRange(component, elementProp, xRange, yRange);
  });

  // Watch for reset from other plots
  component.$watch('$store.plotSyncStore.resetTick', async () => {
    if (sync.lastUpdatedBy === component.plotId || !component.isPlotInitialized) {
      return;
    }
    component.isSyncing = true;
    try {
      await Plotly.relayout(component[elementProp], {
        'xaxis.autorange': true,
        'yaxis.autorange': true,
      });
    } finally {
      component.isSyncing = false;
    }
  });
}

/**
 * Applies synced X/Y axis ranges from another plot.
 * @param {Object} component - Component instance
 * @param {string} elementProp - Property name storing the element reference
 * @param {Object} xRange - X axis range {min, max}
 * @param {Object} yRange - Y axis range {min, max}
 */
async function _applySyncedRange(component, elementProp, xRange, yRange) {
  const el = component[elementProp];
  if (!(el && component.isPlotInitialized)) {
    return;
  }
  const update = {};
  if (xRange) {
    update['xaxis.range'] = [xRange.min, xRange.max];
  }
  if (yRange) {
    update['yaxis.range'] = [yRange.min, yRange.max];
  }
  if (Object.keys(update).length === 0) {
    return;
  }
  component.isSyncing = true;
  try {
    await Plotly.relayout(el, update);
  } finally {
    component.isSyncing = false;
  }
}

/**
 * Sets up parallel coordinates dimension synchronization watchers.
 * @param {Object} component - Component instance
 * @param {string} elementProp - Property name storing the element reference
 * @param {Array} dimensions - Array of dimension objects with key property
 */
export function setupParallelSyncWatchers(component, elementProp, dimensions) {
  const sync = component.$store.plotSyncStore;

  component.$watch('$store.plotSyncStore.parameterRanges', (ranges) => {
    if (sync.lastUpdatedBy === component.plotId || !component.isPlotInitialized) {
      return;
    }
    for (let i = 0; i < dimensions.length; i++) {
      const dimKey = dimensions[i].key;
      const range = ranges[dimKey];
      if (range) {
        _applySyncedDimension(component, elementProp, i, [range.min, range.max]);
      }
    }
  });

  component.$watch('$store.plotSyncStore.resetTick', () => {
    if (sync.lastUpdatedBy === component.plotId || !component.isPlotInitialized) {
      return;
    }
    _resetAllDimensions(component, elementProp);
  });
}

/**
 * Applies synced dimension constraint range from another plot.
 * @param {Object} component - Component instance
 * @param {string} elementProp - Property name storing the element reference
 * @param {number} index - Dimension index
 * @param {Array} constraintRange - [min, max] constraint range
 */
async function _applySyncedDimension(component, elementProp, index, constraintRange) {
  const el = component[elementProp];
  if (!el) {
    return;
  }
  component.isSyncing = true;
  const dimensions = el.data[0]?.dimensions;
  if (dimensions?.[index]) {
    dimensions[index].constraintrange = constraintRange;
    try {
      await Plotly.restyle(el, { dimensions: [dimensions] });
    } finally {
      component.isSyncing = false;
    }
  } else {
    component.isSyncing = false;
  }
}

/**
 * Resets all dimension constraints.
 * @param {Object} component - Component instance
 * @param {string} elementProp - Property name storing the element reference
 */
async function _resetAllDimensions(component, elementProp) {
  const el = component[elementProp];
  if (!el) {
    return;
  }
  component.isSyncing = true;
  const dimensions = el.data[0]?.dimensions;
  if (dimensions) {
    for (const dim of dimensions) {
      dim.constraintrange = undefined;
      dim.range = undefined;
    }
    try {
      await Plotly.restyle(el, { dimensions: [dimensions] });
    } finally {
      component.isSyncing = false;
    }
  } else {
    component.isSyncing = false;
  }
}

/**
 * Creates a value list from columns, excluding specified columns.
 * @param {Array} columns - Column names
 * @param {Array} excludedColumns - Columns to exclude
 * @returns {Array} Array of {key, label} objects
 */
export function createValueList(columns, excludedColumns = []) {
  const filteredColumns = columns.filter((column) => column && !excludedColumns.includes(column));
  return filteredColumns.map((value) => ({
    key: value,
    label: value.replaceAll('_', ' '),
  }));
}

/**
 * Returns the time axes the records can be plotted against. An axis with a statsType is
 * only available when some record was sampled on that clock (e.g. FFW real time needs 'rt').
 * @param {Array} timeAxes - Array of {key, label, statsType?} objects
 * @param {Array} records - Data records
 * @returns {Array} The available time axes
 */
export function availableTimeAxes(timeAxes, records) {
  return timeAxes.filter(
    (axis) => !axis.statsType || records.some((record) => record.stats_type === axis.statsType),
  );
}

/**
 * Returns the records to plot against a time axis, sorted by that axis. Records are limited
 * to the axis's statsType, if it has one, and real time is shifted so the first sample is 0.
 * @param {Array} records - Data records
 * @param {Array} timeAxes - Array of {key, label, statsType?} objects
 * @param {string} xKey - Selected time axis key
 * @returns {Array} Records for the axis, in ascending order of xKey
 */
export function recordsForTimeAxis(records, timeAxes, xKey) {
  const statsType = timeAxes.find((axis) => axis.key === xKey)?.statsType;
  let rows = statsType ? records.filter((record) => record.stats_type === statsType) : records;
  if (statsType && xKey === 'real_time' && rows.length > 0) {
    const start = rows.reduce(
      (min, record) => Math.min(min, record[xKey]),
      Number.POSITIVE_INFINITY,
    );
    rows = rows.map((record) => ({ ...record, [xKey]: record[xKey] - start }));
  }
  return rows.toSorted((a, b) => a[xKey] - b[xKey]);
}

/**
 * Gets label for a key from a value list, with fallback.
 * @param {Array} valueList - Array of {key, label} objects
 * @param {string} key - Key to look up
 * @param {string} fallback - Fallback label if key not found
 * @returns {string} Label or fallback
 */
export function getLabel(valueList, key, fallback) {
  return valueList.find((item) => item.key === key)?.label ?? fallback;
}

/**
 * Returns the extent of a time column, and how many distinct times it holds.
 * The count is what the shared window slices by, so that replay steps sample by
 * sample rather than through gaps the run never sampled.
 * @param {Array} records - Data records
 * @param {string} timeKey - Name of the time column
 * @returns {?{min: number, max: number, samples: number}} The extent, or null when unusable
 */
export function timeExtent(records, timeKey) {
  if (!timeKey) {
    return null;
  }
  const times = new Set();
  for (const record of records) {
    const value = record[timeKey];
    if (Number.isFinite(value)) {
      times.add(value);
    }
  }
  if (times.size === 0) {
    return null;
  }
  const min = Math.min(...times);
  const max = Math.max(...times);
  return max > min ? { min, max, samples: times.size } : null;
}

/**
 * Returns the records falling inside the shared time window.
 * All of them when no window is set, which is the whole-run aggregate.
 * @param {Array} records - Data records
 * @param {string} timeKey - Name of the time column
 * @param {?{min: number, max: number}} timeWindow - The active slice, or null
 * @returns {Array} The records to plot
 */
export function recordsInWindow(records, timeKey, timeWindow) {
  if (!(timeWindow && timeKey)) {
    return records;
  }
  return records.filter((record) => {
    const value = record[timeKey];
    return value >= timeWindow.min && value <= timeWindow.max;
  });
}

/**
 * Reports a plot's time extent to the shared window store, so scrubbing and
 * playback cover everything the run's plots hold between them.
 * @param {Object} component - Component instance
 * @param {Array} records - Data records
 * @param {string} timeKey - Name of the time column
 * @param {{scale: number, suffix: string}} unit - How to show that column's values
 */
export function reportTimeExtent(component, records, timeKey, unit = RAW_TIME) {
  const extent = timeExtent(records, timeKey);
  const runId = component.$store.dataStore.selectedRunId;
  if (extent) {
    component.$store.timeWindowStore.reportBounds(runId, { ...extent, unit });
  } else {
    // Still claim the run, so a previous run's window does not linger.
    component.$store.timeWindowStore.reportBounds(runId, { min: Number.NaN, max: Number.NaN });
  }
}

/**
 * Sets up a watcher that redraws a plot when the shared time window moves.
 * @param {Object} component - Component instance
 * @param {Function} redraw - Function to call when the window changes
 */
export function setupTimeWindowWatcher(component, redraw) {
  component.$watch('$store.timeWindowStore.window', () => {
    if (component.isPlotInitialized) {
      redraw();
    }
  });
}
