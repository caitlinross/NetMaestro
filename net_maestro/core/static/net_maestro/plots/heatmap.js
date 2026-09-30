/**
 * Alpine.js component for heatmap visualization.
 * Displays event communication patterns between LPs as a heatmap.
 */
import _ from 'lodash';
import Plotly from 'plotly';
import { profileForSlot } from './plotProfiles.js';
import {
  DARK_LAYOUT,
  purgePlot,
  setupAxisState,
  setupLoadWatcher,
  setupPlot,
} from './plotUtils.js';

export const heatmapPlot = () => ({
  heatmapPlotEl: null,
  isPlotInitialized: false,
  noData: false,
  records: [],
  selectedMetric: null,

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
      xaxis: { title: this.profile.xTitle },
      yaxis: { title: this.profile.yTitle },
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

  createHeatmapMatrix() {
    if (this.records.length === 0) {
      return null;
    }
    const { sourceKey, destKey } = this.profile;
    const metric = this.metricList.find((m) => m.key === this.selectedMetric);

    const sortedSources = _(this.records)
      .map(sourceKey)
      .reject(_.isUndefined)
      .uniq()
      .sortBy()
      .value();
    const sortedDests = _(this.records).map(destKey).reject(_.isUndefined).uniq().sortBy().value();
    const totals = {};
    for (const record of this.records) {
      const cell = `${record[sourceKey]}_${record[destKey]}`;
      const value = metric?.aggregate === 'sum' ? (record[metric.key] ?? 0) : 1;
      totals[cell] = (totals[cell] ?? 0) + value;
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

  updatePlotData() {
    if (!this.heatmapPlotEl || this.records.length === 0) {
      return;
    }

    const matrix = this.createHeatmapMatrix();
    if (!matrix) {
      return;
    }

    const title =
      this.metricList.find((m) => m.key === this.selectedMetric)?.label || this.selectedMetric;
    Plotly.react(
      this.heatmapPlotEl,
      [
        {
          type: 'heatmap',
          z: matrix.z,
          x: matrix.x,
          y: matrix.y,
          colorscale: 'Viridis',
        },
      ],
      {
        ...DARK_LAYOUT,
        xaxis: { title: this.profile.xTitle },
        yaxis: { title: this.profile.yTitle },
        coloraxis: {
          colorbar: { title: title },
        },
      },
    );
  },
});
