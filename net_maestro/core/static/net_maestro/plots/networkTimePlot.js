/**
 * Alpine.js component for the network time plot.
 *
 * Draws one trace per switch or terminal over the run's time axis. The shared
 * time window clips the x-axis to the slice being replayed, leaving the traces
 * whole so the plot keeps its shape as the window moves across it.
 */
import Plotly from 'plotly';
import { profileForSlot } from './plotProfiles.js';
import {
  availableTimeAxes,
  axisConfig,
  createValueList,
  DARK_LAYOUT,
  getLabel,
  purgePlot,
  RAW_TIME,
  recordsForTimeAxis,
  reportTimeExtent,
  setupAxisState,
  setupLoadWatcher,
  setupPlot,
  setupSelectionWatcher,
  setupTimeWindowWatcher,
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
    setupTimeWindowWatcher(this, () => this.applyTimeWindow());
    setupSelectionWatcher(this, () => this.updatePlotData());
  },

  /**
   * The switch a series belongs to, for matching against the selection.
   *
   * Switch series are keyed by switch id already. Terminal series are keyed by
   * terminal id, and a terminal belongs to the switch it is attached to.
   *
   * @param {string|number} seriesId - The value the profile groups by
   * @returns {?number} The switch id, or null when the series has no switch
   */
  switchOf(seriesId) {
    if (this.profile.groupBy === 'switch_id') {
      return Number(seriesId);
    }
    if (this.profile.groupBy === 'terminal_id') {
      const row = this.records.find((record) => record.terminal_id === Number(seriesId));
      return row?.attached_switch ?? null;
    }
    return null;
  },

  /**
   * A series' name in the legend.
   *
   * @param {string|number} seriesId - The value the profile groups by
   * @returns {string} What to call the trace
   */
  seriesLabel(seriesId) {
    if (this.profile.groupBy === 'switch_id') {
      return String(this.$store.dataStore.switchLabel(Number(seriesId)));
    }
    return `${this.profile.groupBy.replace('_id', '')} ${seriesId}`;
  },

  /**
   * The x-axis range the shared window asks for, or null to show the whole run.
   *
   * Only the virtual-time axis is windowed: the real-time axis is a different
   * clock, sampled on different rows, so a virtual-time slice says nothing
   * about where to cut it.
   *
   * @returns {?Array<number>} The [min, max] range for the x-axis
   */
  windowRange() {
    const { window: timeWindow } = this.$store.timeWindowStore;
    if (!timeWindow || this.selectedXAxis !== this.profile.timeKey) {
      return null;
    }
    const { scale } = this.timeUnit;
    return [timeWindow.min * scale, timeWindow.max * scale];
  },

  /**
   * How this run's virtual time is shown. Only the virtual-time axis is scaled:
   * real time is already in seconds.
   *
   * @returns {{scale: number, suffix: string}} The unit to show values in
   */
  get timeUnit() {
    return this.profile.timeUnit ?? RAW_TIME;
  },

  /** The factor to plot the selected x-axis in. */
  get xScale() {
    return this.selectedXAxis === this.profile.timeKey ? this.timeUnit.scale : 1;
  },

  /** Clip the x-axis to the shared window, or release it back to the whole run. */
  applyTimeWindow() {
    if (!this.networkTimePlotEl) {
      return;
    }
    const range = this.windowRange();
    Plotly.relayout(
      this.networkTimePlotEl,
      range ? { 'xaxis.range': range } : { 'xaxis.autorange': true },
    );
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
    // Virtual-time rows only: real-time samples carry a `ts` of their own that
    // runs well past the model's last virtual-time sample, and taking those in
    // would stretch the shared window over a stretch of run that has no data.
    reportTimeExtent(
      this,
      recordsForTimeAxis(this.records, this.profile.timeAxes, this.profile.timeKey),
      this.profile.timeKey,
      this.timeUnit,
    );
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
    const { xScale: scale } = this;
    for (const record of records) {
      const seriesId = record[this.profile.groupBy];
      if (!groupedData[seriesId]) {
        groupedData[seriesId] = {
          x: [],
          y: [],
          seriesId: seriesId,
        };
      }

      groupedData[seriesId].x.push(record[this.selectedXAxis] * scale);
      groupedData[seriesId].y.push(record[this.selectedYAxis]);
    }

    const selection = this.$store.selectionStore;
    const traces = Object.values(groupedData).map((lpData) => {
      const switchId = this.switchOf(lpData.seriesId);
      // A series with no switch behind it cannot be outside the selection, so
      // it stays at full strength rather than fading for no stated reason.
      const inSelection = switchId === null || selection.matchesSwitch(switchId);
      return {
        x: lpData.x,
        y: lpData.y,
        name: this.seriesLabel(lpData.seriesId),
        showlegend: true,
        opacity: inSelection ? 1 : 0.15,
      };
    });

    const range = this.windowRange();
    Plotly.react(this.networkTimePlotEl, traces, {
      ...DARK_LAYOUT,
      xaxis: axisConfig(
        getLabel(this.xAxisValues, this.selectedXAxis, this.selectedXAxis),
        range ? { range } : { autorange: true },
      ),
      yaxis: axisConfig(getLabel(this.yAxisValues, this.selectedYAxis, this.selectedYAxis)),
    });
  },
});
