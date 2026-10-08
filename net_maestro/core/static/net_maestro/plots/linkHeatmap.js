/**
 * Alpine.js component for the link activity heatmap.
 *
 * One row per directed link, one column per sample, so the whole run's traffic
 * reads at once: a bottleneck link is a bright band, a quiet one a dark stripe,
 * and a link that pauses shows where.
 *
 * Unlike the plots beside it this one does not narrow to the shared time window.
 * Its job is to show the run so the window can be placed on it, so instead it
 * marks the window and hands a clicked column back to the store. Clipping it
 * would leave a single column and nothing to navigate by.
 */
import Plotly from 'plotly';
import {
  axisConfig,
  DARK_LAYOUT,
  PAUSED_COLOR,
  purgePlot,
  reportTimeExtent,
  SECONDS_FROM_NS,
  setupAxisState,
  setupLoadWatcher,
  setupPlot,
} from './plotUtils.js';

// biome-ignore lint/style/useNamingConvention: matches the API's ?stats_type= query param
const PARAMS = { stats_type: 'vt' };
const TIME_KEY = 'ts';

const METRICS = [
  { key: 'port_sent_mbit', label: 'Sent (Mbit)' },
  { key: 'port_queued_mbit', label: 'Queued (Mbit)' },
  { key: 'port_output_paused', label: 'Output paused', binary: true },
];

// Off-white on the dark canvas: the window marker has to read over Viridis at
// both ends, where a mid-tone would vanish against the greens.
const WINDOW_EDGE = '#ffffff';

export const linkHeatmap = () => ({
  linkHeatmapEl: null,
  isPlotInitialized: false,
  noData: false,
  records: [],
  selectedMetric: null,

  init() {
    setupAxisState(this, 'linkHeatmap', [{ prop: 'selectedMetric', default: METRICS[0].key }]);
    setupLoadWatcher(this, () => this.load());
    // Only the marker moves with the window, so redraw the layout, not the data.
    this.$watch('$store.timeWindowStore.window', () => this.markWindow());
  },

  get metricList() {
    return METRICS;
  },

  get metric() {
    return METRICS.find((m) => m.key === this.selectedMetric) ?? METRICS[0];
  },

  initPlot() {
    setupPlot({
      component: this,
      elementId: 'linkHeatmap',
      elementProp: 'linkHeatmapEl',
      data: [{ type: 'heatmap', z: [], x: [], y: [] }],
      layout: {
        ...DARK_LAYOUT,
        xaxis: axisConfig('Virtual Time (s)', { automargin: true }),
        yaxis: axisConfig('Link', { automargin: true }),
      },
      eventHandlers: [{ event: 'plotly_click', handler: (event) => this.seekToPoint(event) }],
    });
  },

  async load() {
    this.initPlot();
    this.noData = false;
    const payload = await this.$store.dataStore.fetchRunData('ffw-ports', PARAMS);
    this.records = (payload?.data ?? []).filter((record) => !record.is_terminal);
    reportTimeExtent(this, this.records, TIME_KEY, SECONDS_FROM_NS);
    if (!METRICS.some((m) => m.key === this.selectedMetric)) {
      this.selectedMetric = METRICS[0].key;
    }
    if (this.records.length === 0) {
      this.noData = true;
      this.purge();
      return;
    }
    this.updatePlotData();
  },

  purge() {
    purgePlot(this, 'linkHeatmapEl');
  },

  /**
   * Put the shared window where the user clicked, so the network view and the
   * plots beside it jump to that moment of the run.
   *
   * @param {Object} event - Plotly click event data
   */
  seekToPoint(event) {
    const seconds = event?.points?.[0]?.x;
    if (Number.isFinite(seconds)) {
      // The axis is in seconds; the store keeps the run's raw values.
      this.$store.timeWindowStore.seekTime(seconds / SECONDS_FROM_NS.scale);
    }
  },

  /** A link's label, which is also its row. */
  linkLabel(record) {
    const store = this.$store.dataStore;
    return `${store.switchLabel(record.switch_id)} → ${store.switchLabel(record.target_index)}`;
  },

  /**
   * One row per link, one column per sample time.
   *
   * A link with no sample at some time leaves a hole rather than a zero, so a
   * gap in the run reads as missing instead of as an idle link.
   *
   * @returns {?Object} Plotly heatmap data, or null when there is nothing to draw
   */
  matrix() {
    if (this.records.length === 0) {
      return null;
    }
    const { key, binary } = this.metric;
    const times = [...new Set(this.records.map((record) => record[TIME_KEY]))].sort(
      (a, b) => a - b,
    );
    const seconds = times.map((time) => time * SECONDS_FROM_NS.scale);
    const columnOf = new Map(times.map((time, index) => [time, index]));
    const labels = [...new Set(this.records.map((record) => this.linkLabel(record)))].sort();
    const rowOf = new Map(labels.map((label, index) => [label, index]));

    const z = labels.map(() => new Array(times.length).fill(null));
    for (const record of this.records) {
      const row = rowOf.get(this.linkLabel(record));
      const column = columnOf.get(record[TIME_KEY]);
      if (row === undefined || column === undefined) {
        continue;
      }
      const value = record[key];
      z[row][column] = binary ? Number(Boolean(value)) : (value ?? 0);
    }
    return { z, x: seconds, y: labels };
  },

  /** The color ramp for the chosen metric. */
  colorscale() {
    if (!this.metric.binary) {
      return 'Viridis';
    }
    // Two states, so a ramp would imply degrees of pausing that do not exist.
    return [
      [0, '#2a2f38'],
      [1, PAUSED_COLOR],
    ];
  },

  /** Shapes marking the active window, or none while the whole run is shown. */
  windowShapes() {
    const { window: timeWindow } = this.$store.timeWindowStore;
    if (!timeWindow) {
      return [];
    }
    return [
      {
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: timeWindow.min * SECONDS_FROM_NS.scale,
        x1: timeWindow.max * SECONDS_FROM_NS.scale,
        y0: 0,
        y1: 1,
        // Outline only. A translucent fill would wash out the cells inside the
        // window, which are the ones being looked at.
        line: { color: WINDOW_EDGE, width: 2 },
        fillcolor: 'rgba(0, 0, 0, 0)',
        layer: 'above',
      },
    ];
  },

  /** Move the window marker without rebuilding the matrix behind it. */
  markWindow() {
    if (this.isPlotInitialized && this.linkHeatmapEl) {
      Plotly.relayout(this.linkHeatmapEl, { shapes: this.windowShapes() });
    }
  },

  updatePlotData() {
    const matrix = this.matrix();
    if (!(this.linkHeatmapEl && matrix)) {
      return;
    }
    Plotly.react(
      this.linkHeatmapEl,
      [
        {
          type: 'heatmap',
          z: matrix.z,
          x: matrix.x,
          y: matrix.y,
          colorscale: this.colorscale(),
          zsmooth: false,
          hovertemplate: `%{y}<br>t = %{x:.3f} s<br>${this.metric.label} = %{z}<extra></extra>`,
          colorbar: { title: { text: this.metric.label }, titleside: 'right' },
        },
      ],
      {
        ...DARK_LAYOUT,
        xaxis: axisConfig('Virtual Time (s)', { automargin: true }),
        yaxis: axisConfig('Link', { automargin: true, autorange: 'reversed' }),
        shapes: this.windowShapes(),
      },
    );
  },
});
