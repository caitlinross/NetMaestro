/**
 * Alpine.js component for parallel coordinates plot visualization.
 * Displays multi-dimensional ROSS data using Plotly's parallel coordinates chart.
 */
import Plotly from 'plotly';
import { profileForSlot } from './plotProfiles.js';
import {
  DARK_LAYOUT,
  purgePlot,
  setupLoadWatcher,
  setupParallelSyncWatchers,
  setupPlot,
} from './plotUtils.js';

export const parallelCoords = () => ({
  parallelPlotEl: null,
  isPlotInitialized: false,
  noData: false,
  plotId: 'parallelCoords',
  isSyncing: false,
  records: [],
  plotDimensions: [...profileForSlot('simulation', null).parallelDimensions],

  get profile() {
    const store = this.$store.dataStore;
    return profileForSlot('simulation', store.datasets, store.slotSources.simulation);
  },

  /**
   * Initialize the component and set up watchers.
   */
  init() {
    setupLoadWatcher(this, () => this.load());
    setupParallelSyncWatchers(this, 'parallelPlotEl', this.plotDimensions);
  },

  /**
   * Handle user constraint range changes on dimensions.
   * Publishes the current constraint state to plotSyncStore.
   */
  onRestyle() {
    if (this.isSyncing) {
      return;
    }
    const sync = this.$store.plotSyncStore;
    const dimensions = this.parallelPlotEl.data[0]?.dimensions;
    if (!dimensions) {
      return;
    }

    const updates = this.plotDimensions.map((dim, i) => {
      const constraint = dimensions[i]?.constraintrange;
      return {
        parameter: dim.key,
        range: constraint ? { min: constraint[0], max: constraint[1] } : null,
      };
    });

    if (updates.every((u) => u.range === null)) {
      sync.resetAll(this.plotId);
      return;
    }
    sync.updateRanges(updates, this.plotId);
  },

  /**
   * Initialize the Plotly parallel coordinates plot.
   */
  initPlot() {
    const data = [
      {
        type: 'parcoords',
        line: {
          color: [],
          colorscale: 'Viridis',
          showscale: true,
        },
        dimensions: [{}],
      },
    ];
    const layout = DARK_LAYOUT;
    setupPlot({
      component: this,
      elementId: 'parallelCoords',
      elementProp: 'parallelPlotEl',
      data,
      layout,
      eventHandlers: [
        {
          event: 'plotly_restyle',
          handler: () => this.onRestyle(),
        },
      ],
    });
  },

  async load() {
    this.initPlot();
    await this.loadRossData();
  },

  async loadRossData() {
    this.noData = false;
    const payload = await this.$store.dataStore.fetchRunData(
      this.profile.dataset,
      this.profile.params,
    );
    this.records = payload?.data ?? [];
    this.plotDimensions.splice(0, this.plotDimensions.length, ...this.profile.parallelDimensions);
    if (this.records.length === 0) {
      this.noData = true;
      this.purge();
      return;
    }
    this.updatePlotData();
  },

  purge() {
    purgePlot(this, 'parallelPlotEl');
  },

  /**
   * Update the plot with current axis selections.
   */
  updatePlotData() {
    if (!this.parallelPlotEl || this.records.length === 0) {
      return;
    }

    const trace = {
      type: 'parcoords',
      line: {
        color: this.records.map((record) => record[this.profile.groupBy]),
        colorscale: 'Viridis',
        showscale: true,
      },
      dimensions: this.plotDimensions.map((dimension) => ({
        label: dimension.label,
        values: this.records.map((record) => record[dimension.key]),
      })),
    };

    Plotly.react(this.parallelPlotEl, [trace], DARK_LAYOUT);
  },
});
