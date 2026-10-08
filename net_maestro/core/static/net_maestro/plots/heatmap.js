/**
 * Alpine.js component for heatmap visualization.
 * Displays event communication patterns between LPs as a heatmap.
 *
 * The matrix sums over every sample the run holds, unless the shared time window
 * narrows it to one slice. Axes and the color scale are held to the whole run
 * either way, so a slice can be read against the run it came from rather than
 * against itself.
 */
import _ from 'lodash';
import Plotly from 'plotly';
import { profileForSlot } from './plotProfiles.js';
import {
  axisConfig,
  DARK_LAYOUT,
  maxValuePerSlice,
  purgePlot,
  recordsInWindow,
  reportTimeExtent,
  setupAxisState,
  setupLoadWatcher,
  setupPlot,
  setupTimeWindowWatcher,
} from './plotUtils.js';

export const heatmapPlot = () => ({
  heatmapPlotEl: null,
  isPlotInitialized: false,
  noData: false,
  records: [],
  selectedMetric: null,
  // Highest cell value any one slice reaches, cached per metric and slice count.
  sliceCeiling: null,
  sliceCeilingKey: null,

  get profile() {
    const store = this.$store.dataStore;
    return profileForSlot('heatmap', store.datasets, store.slotSources.heatmap);
  },

  get metricList() {
    return this.profile.metrics;
  },

  /** The card heading, which follows whichever source the slot is reading. */
  get plotTitle() {
    return this.profile.title ?? 'Heatmap';
  },

  /**
   * Turn an axis of switch ids into the topology's switch names.
   *
   * Only for profiles whose axes are switch ids. Ids with no name keep the id,
   * so a run whose topology has gone missing still plots. Plotly reads a string
   * axis as categorical, which is what these discrete switches want anyway.
   *
   * @param {Array<number>} ids - Axis values as they come from the records
   * @returns {Array<number|string>} The values to hand Plotly
   */
  axisTicks(ids) {
    if (this.profile.axisLabels !== 'switches') {
      return ids;
    }
    return ids.map((id) => String(this.$store.dataStore.switchLabel(id)));
  },

  /**
   * Initialize the component and set up watchers.
   */
  init() {
    setupAxisState(this, 'heatmapPlot', [{ prop: 'selectedMetric', default: 'num_messages' }]);
    setupLoadWatcher(this, () => this.load());
    setupTimeWindowWatcher(this, () => this.updatePlotData());
  },

  /**
   * Initialize the Plotly heatmap plot.
   */
  initPlot() {
    const data = [
      {
        type: 'heatmap',
        z: [],
        x: [],
        y: [],
        colorscale: 'Viridis',
      },
    ];
    const layout = {
      ...DARK_LAYOUT,
      xaxis: axisConfig(this.profile.xTitle, { automargin: true }),
      yaxis: axisConfig(this.profile.yTitle, { automargin: true }),
    };
    setupPlot({
      component: this,
      elementId: 'heatmapPlot',
      elementProp: 'heatmapPlotEl',
      data,
      layout,
    });
  },

  async load() {
    this.initPlot();
    await this.loadEventData();
  },

  async loadEventData() {
    this.noData = false;
    const payload = await this.$store.dataStore.fetchRunData(
      this.profile.dataset,
      this.profile.params,
    );
    const { include } = this.profile;
    this.records = (payload?.data ?? []).filter((record) => !include || include(record));
    this.sliceCeiling = null;
    this.sliceCeilingKey = null;
    reportTimeExtent(this, this.records, this.profile.timeKey, this.profile.timeUnit);
    // A saved metric may belong to another simulation type; use this type's first metric.
    if (!this.metricList.some((m) => m.key === this.selectedMetric && !m.disabled)) {
      this.selectedMetric = this.metricList[0].key;
    }
    if (this.records.length === 0) {
      this.noData = true;
      this.purge();
      return;
    }
    this.updatePlotData();
  },

  purge() {
    purgePlot(this, 'heatmapPlotEl');
  },

  /** The metric currently being summed into the cells. */
  get metric() {
    return this.metricList.find((m) => m.key === this.selectedMetric);
  },

  /**
   * What one record contributes to its cell: the metric's own value when the
   * metric sums one, and otherwise a single count of the record.
   *
   * @param {Object} record - One data record
   * @returns {number} The record's contribution
   */
  cellValue(record) {
    const metric = this.metric;
    return metric?.aggregate === 'sum' ? (record[metric.key] ?? 0) : 1;
  },

  createHeatmapMatrix() {
    if (this.records.length === 0) {
      return null;
    }
    const { sourceKey, destKey, timeKey } = this.profile;

    // Axes come from every record, not just the windowed ones, so the grid holds
    // still while the window moves over it.
    const sortedSources = _(this.records)
      .map(sourceKey)
      .reject(_.isUndefined)
      .uniq()
      .sortBy()
      .value();
    const sortedDests = _(this.records).map(destKey).reject(_.isUndefined).uniq().sortBy().value();

    const windowed = recordsInWindow(this.records, timeKey, this.$store.timeWindowStore.window);
    const totals = {};
    for (const record of windowed) {
      const cell = `${record[sourceKey]}_${record[destKey]}`;
      totals[cell] = (totals[cell] ?? 0) + this.cellValue(record);
    }

    const z = sortedSources.map((source) =>
      sortedDests.map((dest) => totals[`${source}_${dest}`] ?? 0),
    );

    return {
      z,
      x: this.axisTicks(sortedDests),
      y: this.axisTicks(sortedSources),
    };
  },

  /**
   * The value the color scale tops out at, or null to let Plotly autoscale.
   *
   * Autoscaling per frame would recolor the whole grid on every step of a
   * replay, so while a window is set the scale is pinned to the busiest cell any
   * one slice of this run reaches. That costs one pass over the records, cached
   * until the metric or the slice count changes.
   *
   * @returns {?number} The ceiling for `zmax`
   */
  colorCeiling() {
    const store = this.$store.timeWindowStore;
    if (!(store.window && store.ready && this.profile.timeKey)) {
      return null;
    }
    const key = `${this.selectedMetric}|${store.sliceCount}`;
    if (this.sliceCeilingKey !== key) {
      this.sliceCeiling = this.maxCellPerSlice(store);
      this.sliceCeilingKey = key;
    }
    return this.sliceCeiling;
  },

  /**
   * Highest value any one cell reaches within a single slice of the run.
   *
   * @param {Object} store - The time window store, for the run's bounds and slicing
   * @returns {?number} The maximum, or null when nothing lands in a slice
   */
  maxCellPerSlice(store) {
    const { sourceKey, destKey, timeKey } = this.profile;
    return maxValuePerSlice(this.records, {
      timeKey,
      bounds: store.bounds,
      sliceCount: store.sliceCount,
      keyOf: (record) => `${record[sourceKey]}_${record[destKey]}`,
      amountOf: (record) => this.cellValue(record),
    });
  },

  updatePlotData() {
    if (!this.heatmapPlotEl || this.records.length === 0) {
      return;
    }

    const matrix = this.createHeatmapMatrix();
    if (!matrix) {
      return;
    }

    const metricLabel = this.metric?.label || this.selectedMetric;
    const ceiling = this.colorCeiling();
    Plotly.react(
      this.heatmapPlotEl,
      [
        {
          type: 'heatmap',
          z: matrix.z,
          x: matrix.x,
          y: matrix.y,
          colorscale: 'Viridis',
          // On the trace: the plot has no coloraxis for a layout-level colorbar to reach.
          colorbar: { title: { text: metricLabel }, titleside: 'right' },
          ...(ceiling === null ? {} : { zmin: 0, zmax: ceiling }),
        },
      ],
      {
        ...DARK_LAYOUT,
        xaxis: axisConfig(this.profile.xTitle, { automargin: true }),
        yaxis: axisConfig(this.profile.yTitle, { automargin: true }),
      },
    );
  },
});
