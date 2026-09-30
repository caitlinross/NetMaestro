import { sourcesForSlot } from './plots/plotProfiles.js';

/**
 * Coordinates zoom/pan across plots that share the same axis parameter.
 *
 * Each plot publishes its current axis ranges keyed by parameter name
 * (e.g. 'virtual_time', 'events_processed'). Other plots watching
 * the same parameter apply the range, preventing circular updates
 * via the lastUpdatedBy / isSyncing guard pattern.
 */
export const plotSyncStore = {
  // { parameterName: { min, max } }
  parameterRanges: {},
  // Which plot last wrote a range (used to skip self-sync)
  lastUpdatedBy: null,
  // Incremented on double-click reset so watchers can react
  resetTick: 0,

  /**
   * Called by the plot that the user interacted with.
   * @param {string} parameter - axis parameter name
   * @param {{ min: number, max: number } | null} range - null = autorange
   * @param {string} plotId - unique id of the originating plot
   */
  updateRange(parameter, range, plotId) {
    this.lastUpdatedBy = plotId;
    if (range) {
      this.parameterRanges = {
        ...this.parameterRanges,
        [parameter]: { min: range.min, max: range.max },
      };
    } else {
      // Remove the constraint (autorange)
      const next = { ...this.parameterRanges };
      delete next[parameter];
      this.parameterRanges = next;
    }
  },

  /**
   * Batch-update multiple parameter ranges at once.
   * Triggers only one watcher notification regardless of how many
   * parameters changed.
   * @param {Array<{ parameter: string, range: { min: number, max: number } | null }>} updates
   * @param {string} plotId - unique id of the originating plot
   */
  updateRanges(updates, plotId) {
    this.lastUpdatedBy = plotId;
    const next = { ...this.parameterRanges };
    for (const { parameter, range } of updates) {
      if (range) {
        next[parameter] = { min: range.min, max: range.max };
      } else {
        delete next[parameter];
      }
    }
    this.parameterRanges = next;
  },

  /**
   * Broadcast a full reset (double-click) from the given plot.
   */
  resetAll(plotId) {
    this.lastUpdatedBy = plotId;
    this.parameterRanges = {};
    this.resetTick++;
  },
};

export const dataStore = {
  // loadTick: incremented when "Load Data" is clicked to trigger plot updates
  loadTick: 0,

  // Currently selected run ID
  selectedRunId: null,
  simulationType: null,

  // Row counts per dataset for the selected run, from /api/v1/runs/<id>/datasets.
  // A run can hold both FFW model stats and ROSS engine stats, so plots resolve
  // their dataset from this rather than from simulationType.
  datasets: null,
  // Switch names from the run's topology, indexed by switch_id. Empty when the run
  // has no topology to read, and plots then fall back to the numeric ids.
  switchNames: [],
  // Per-slot source override chosen in the UI, e.g. { simulation: 'ffw' }.
  slotSources: {},

  async fetchRossData() {
    if (!this.selectedRunId) {
      return null;
    }
    const response = await fetch(`/api/v1/runs/${this.selectedRunId}/ross`);
    if (!response.ok) {
      throw new Error(`Failed to fetch ROSS data: ${response.statusText}`);
    }
    return await response.json();
  },

  async fetchEventData() {
    if (!this.selectedRunId) {
      return null;
    }
    const response = await fetch(`/api/v1/runs/${this.selectedRunId}/event`);
    if (!response.ok) {
      throw new Error(`Failed to fetch event data: ${response.statusText}`);
    }
    return await response.json();
  },

  async fetchModelData() {
    if (!this.selectedRunId) {
      return null;
    }
    const response = await fetch(`/api/v1/runs/${this.selectedRunId}/model`);
    if (!response.ok) {
      throw new Error(`Failed to fetch model data: ${response.statusText}`);
    }
    return await response.json();
  },

  async fetchRunData(dataset, params = {}) {
    if (!this.selectedRunId) {
      return null;
    }
    const query = new URLSearchParams(params).toString();
    const url = `/api/v1/runs/${this.selectedRunId}/${dataset}${query ? `?${query}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${dataset} data: ${response.statusText}`);
    }
    return await response.json();
  },

  /**
   * Select a run and trigger data reload from DB records.
   * @param {number} runId - The run primary key
   * @param {string} simulationType - The run's simulation type
   */
  selectRun(runId, simulationType) {
    this.selectedRunId = runId;
    this.simulationType = simulationType;
    this.datasets = null;
    this.switchNames = [];
    this.slotSources = {};
    // Plots load once the manifest lands, so they resolve against the real datasets.
    this.fetchDatasets();
  },

  /** Load which datasets this run holds, then trigger the plots. */
  async fetchDatasets() {
    const runId = this.selectedRunId;
    try {
      const response = await fetch(`/api/v1/runs/${runId}/datasets`);
      if (response.ok && runId === this.selectedRunId) {
        const manifest = await response.json();
        this.datasets = manifest.datasets;
        this.switchNames = manifest.switch_names ?? [];
      }
    } catch (error) {
      console.warn('Failed to fetch run datasets; falling back to simulation type', error);
    }
    this.loadTick++;
  },

  /** A switch's name from the run's topology, or its id when there is no name for it. */
  switchLabel(switchId) {
    return this.switchNames[switchId] ?? switchId;
  },

  /** The sources this run has data for, for one plot slot (used by the tab's toggle). */
  slotOptions(slot) {
    return sourcesForSlot(slot, this.datasets);
  },

  /** The source a slot is currently reading from. */
  activeSlotSource(slot) {
    const options = this.slotOptions(slot);
    const chosen = this.slotSources[slot];
    return (options.find((o) => o.source === chosen) ?? options[0])?.source ?? null;
  },

  /** Choose which source a plot slot reads from, and reload the plots. */
  setSlotSource(slot, source) {
    this.slotSources = { ...this.slotSources, [slot]: source };
    this.loadTick++;
  },
};
