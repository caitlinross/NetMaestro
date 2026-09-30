import Plotly from 'plotly';
import { profileForSlot } from './plotProfiles.js';
import {
  availableTimeAxes,
  axisConfig,
  createValueList,
  DARK_LAYOUT,
  getLabel,
  purgePlot,
  recordsForTimeAxis,
  setupAxisState,
  setupLoadWatcher,
  setupPlot,
} from './plotUtils.js';

export const networkTimePlot = () => ({
  records: [],
  columns: [],
  selectedXAxis: null,
  selectedYAxis: null,
  networkTimePlotEl: null,
  isPlotInitialized: false,
  isLoaded: false,
  noData: false,

  get profile() {
    const store = this.$store.dataStore;
    return profileForSlot('networkTime', store.datasets, store.slotSources.networkTime);
  },

  get xAxisValues() {
    return availableTimeAxes(this.profile.timeAxes, this.records);
  },
  get yAxisValues() {
    return createValueList(this.columns, this.profile.excludedColumns);
  },

  /**
   * Initialize the component and set up watchers.
   * Called automatically by Alpine.js when component mounts.
   */
  init() {
    setupAxisState(this, 'networkTimePlot', [
      { prop: 'selectedXAxis', default: 'virtual_time' },
      { prop: 'selectedYAxis', default: 'send_count' },
    ]);
    setupLoadWatcher(this, () => this.load());
  },

  /**
   * Initialize the Plotly networkTime plot.
   */
  initPlot() {
    const layout = {
      ...DARK_LAYOUT,
      xaxis: axisConfig('Virtual Time', { rangemode: 'tozero' }),
      yaxis: axisConfig('Send Count', { rangemode: 'tozero' }),
    };
    const data = [{ x: [], y: [], showlegend: true }];
    setupPlot({
      component: this,
      elementId: 'networkTimePlot',
      elementProp: 'networkTimePlotEl',
      data,
      layout,
    });
  },

  async load() {
    this.initPlot();
    await this.loadModelData();
  },

  async loadModelData() {
    this.noData = false;
    const payload = await this.$store.dataStore.fetchRunData(
      this.profile.dataset,
      this.profile.timeParams ?? this.profile.params,
    );
    this.columns = payload?.columns ?? [];
    this.records = payload?.data ?? [];
    // Saved axes may belong to another simulation type; fall back to this type's defaults.
    if (
      this.columns.length > 0 &&
      !(
        this.columns.includes(this.selectedXAxis) &&
        this.xAxisValues.some((axis) => axis.key === this.selectedXAxis)
      )
    ) {
      this.selectedXAxis = this.profile.defaults.x;
    }
    if (this.columns.length > 0 && !this.columns.includes(this.selectedYAxis)) {
      this.selectedYAxis = this.profile.defaults.y;
    }
    if (this.records.length === 0) {
      this.noData = true;
      this.purge();
      return;
    }
    this.updatePlotData();
  },

  purge() {
    purgePlot(this, 'networkTimePlotEl');
  },

  /**
   * Update the plot with current axis selections.
   * Groups data by lp_id to create separate traces.
   */
  updatePlotData() {
    if (!(this.networkTimePlotEl && this.records.length)) {
      return;
    }

    const groupedData = {};

    const records = recordsForTimeAxis(this.records, this.xAxisValues, this.selectedXAxis);
    for (const record of records) {
      const seriesId = record[this.profile.groupBy];
      if (!groupedData[seriesId]) {
        groupedData[seriesId] = {
          x: [],
          y: [],
          seriesId: seriesId,
        };
      }

      groupedData[seriesId].x.push(record[this.selectedXAxis]);
      groupedData[seriesId].y.push(record[this.selectedYAxis]);
    }

    const traces = Object.values(groupedData).map((lpData) => ({
      x: lpData.x,
      y: lpData.y,
      showlegend: true,
    }));

    Plotly.react(this.networkTimePlotEl, traces, {
      ...DARK_LAYOUT,
      xaxis: axisConfig(getLabel(this.xAxisValues, this.selectedXAxis, this.selectedXAxis)),
      yaxis: axisConfig(getLabel(this.yAxisValues, this.selectedYAxis, this.selectedYAxis)),
    });
  },
});
