/**
 * Alpine.js component for the network view.
 *
 * Draws the run's topology and colors it with what the run was doing: each
 * switch by how full its shared buffer was, each link by how much crossed it,
 * dashed where a port had paused its output. The shared time window decides
 * which samples that covers, so pressing play walks the picture through the run.
 *
 * Only runs carrying an FFW config can be drawn, since the switches and links
 * come from the topology file the run named rather than from its own records.
 */
import { createGraph, fitGraph, THEME } from '../topology/graph.js';
import {
  maxValuePerSlice,
  PAUSED_COLOR,
  recordsInWindow,
  reportTimeExtent,
  SECONDS_FROM_NS,
} from './plotUtils.js';

// Sampling mode the view reads. Virtual time is the clock the window speaks.
// biome-ignore lint/style/useNamingConvention: matches the API's ?stats_type= query param
const PARAMS = { stats_type: 'vt' };
const TIME_KEY = 'ts';

// Viridis, as a handful of stops. The heatmap beside this view uses Plotly's
// Viridis, so a busy link and a hot cell read as the same kind of busy.
const VIRIDIS = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

// An edge with nothing crossing it still has to be visible, so link width runs
// from a floor rather than from nothing.
const MIN_EDGE_WIDTH = 2;
const MAX_EDGE_WIDTH = 8;

/**
 * Sample the Viridis ramp.
 *
 * @param {number} fraction - Position on the ramp, 0 to 1
 * @returns {string} A CSS rgb() color
 */
function viridis(fraction) {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const scaled = clamped * (VIRIDIS.length - 1);
  const index = Math.min(Math.floor(scaled), VIRIDIS.length - 2);
  const t = scaled - index;
  const [r1, g1, b1] = VIRIDIS[index];
  const [r2, g2, b2] = VIRIDIS[index + 1];
  const mix = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}

/** Style rules that let the run's state drive the drawing. */
const stateStyle = () => [
  {
    selector: 'node[stateColor]',
    style: {
      'background-color': 'data(stateColor)',
      // The terminal strip sits on the fill, so drop it while state is shown.
      'background-image': 'none',
    },
  },
  {
    selector: 'edge[stateColor]',
    style: {
      'line-color': 'data(stateColor)',
      'target-arrow-color': 'data(stateColor)',
      width: 'data(stateWidth)',
    },
  },
  {
    selector: 'edge[?paused]',
    style: {
      'line-style': 'dashed',
      'line-color': PAUSED_COLOR,
      'target-arrow-color': PAUSED_COLOR,
    },
  },
];

export const networkView = () => ({
  cy: null,
  resizeObserver: null,
  topology: null,
  switchRecords: [],
  portRecords: [],
  loading: false,
  // Why there is nothing to draw, or null when there is.
  unavailable: null,
  // Highest mbit any one link carries in a single slice, for a stable color scale.
  ceiling: null,
  ceilingKey: null,

  init() {
    if (this.$store.dataStore.selectedRunId) {
      this.load();
    }
    this.$watch('$store.dataStore.loadTick', () => this.load());
    this.$watch('$store.timeWindowStore.window', () => this.paint());
  },

  destroy() {
    this.teardown();
  },

  teardown() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cy?.destroy();
    this.cy = null;
  },

  /** Load the run's topology and the samples that color it. */
  async load() {
    const store = this.$store.dataStore;
    const topologyUrl = store.datasets && store.topology?.url;
    this.ceiling = null;
    this.ceilingKey = null;
    if (!topologyUrl) {
      this.fail('This run has no topology on file, so its network cannot be drawn.');
      return;
    }
    if (!((store.datasets['ffw-switches'] ?? 0) && (store.datasets['ffw-ports'] ?? 0))) {
      this.fail('This run has no FFW switch and port samples to draw.');
      return;
    }

    this.loading = true;
    try {
      const [topology, switches, ports] = await Promise.all([
        fetch(topologyUrl).then((response) => {
          if (!response.ok) {
            throw new Error(`topology request failed with status ${response.status}`);
          }
          return response.json();
        }),
        store.fetchRunData('ffw-switches', PARAMS),
        store.fetchRunData('ffw-ports', PARAMS),
      ]);
      this.topology = topology;
      this.switchRecords = switches?.data ?? [];
      this.portRecords = (ports?.data ?? []).filter((record) => !record.is_terminal);
    } catch (error) {
      this.fail(`Could not load the network: ${error.message}`);
      return;
    } finally {
      this.loading = false;
    }

    this.unavailable = null;
    reportTimeExtent(this, this.portRecords, TIME_KEY, SECONDS_FROM_NS);
    this.$nextTick(() => this.draw());
  },

  /**
   * Give up on drawing, saying why.
   *
   * @param {string} reason - What to tell the user
   */
  fail(reason) {
    this.teardown();
    this.topology = null;
    this.switchRecords = [];
    this.portRecords = [];
    this.unavailable = reason;
    this.loading = false;
  },

  /** Draw the graph, then color it for the current window. */
  draw() {
    const container = this.$refs.canvas;
    if (!(container && this.topology)) {
      return;
    }
    this.teardown();
    this.cy = createGraph(container, this.topology, stateStyle());
    this.resizeObserver = new ResizeObserver(() => fitGraph(this.cy));
    this.resizeObserver.observe(container);
    this.paint();
  },

  /**
   * The name a switch id belongs to, which is also its node id on the canvas.
   *
   * @param {number} switchId - The id the model reports
   * @returns {?string} The switch's name, or null when the topology has none
   */
  nodeId(switchId) {
    const name = this.$store.dataStore.switchNames[switchId];
    return name ?? null;
  },

  /**
   * Highest mbit any one link carries within a single slice.
   *
   * Pinning the color scale to this keeps a busy link the same color from frame
   * to frame, where rescaling per frame would make every step look alike.
   *
   * @returns {?number} The ceiling, or null while the whole run is shown
   */
  colorCeiling() {
    const store = this.$store.timeWindowStore;
    if (!(store.window && store.ready)) {
      return null;
    }
    const key = String(store.sliceCount);
    if (this.ceilingKey !== key) {
      this.ceiling = maxValuePerSlice(this.portRecords, {
        timeKey: TIME_KEY,
        bounds: store.bounds,
        sliceCount: store.sliceCount,
        keyOf: (record) => `${record.switch_id}->${record.target_index}`,
        amountOf: (record) => record.port_sent_mbit ?? 0,
      });
      this.ceilingKey = key;
    }
    return this.ceiling;
  },

  /**
   * How full each switch's shared buffer was over the window.
   *
   * Occupancy is a level rather than a total, so it averages over the samples
   * the window covers.
   *
   * @returns {Map<string, number>} Occupancy fraction keyed by node id
   */
  switchState() {
    const rows = recordsInWindow(this.switchRecords, TIME_KEY, this.$store.timeWindowStore.window);
    const sums = new Map();
    for (const record of rows) {
      const id = this.nodeId(record.switch_id);
      const capacity = record.shared_buffer_capacity_mbit;
      if (id === null || !(capacity > 0)) {
        continue;
      }
      const entry = sums.get(id) ?? { total: 0, samples: 0 };
      entry.total += (record.shared_buffer_occupancy_mbit ?? 0) / capacity;
      entry.samples += 1;
      sums.set(id, entry);
    }
    return new Map([...sums].map(([id, entry]) => [id, entry.total / entry.samples]));
  },

  /**
   * What crossed each link over the window.
   *
   * Sent mbit accumulates, so it sums; queued is a level, so it averages. A
   * pause counts if the port was paused at any sample in the window, which is
   * how a pause shorter than one slice still shows up.
   *
   * @returns {Map<string, Object>} State keyed by edge id
   */
  edgeState() {
    const rows = recordsInWindow(this.portRecords, TIME_KEY, this.$store.timeWindowStore.window);
    const edges = new Map();
    for (const record of rows) {
      const id = this.edgeId(record);
      if (id === null) {
        continue;
      }
      const entry = edges.get(id) ?? { sent: 0, queued: 0, samples: 0, paused: false };
      entry.sent += record.port_sent_mbit ?? 0;
      entry.queued += record.port_queued_mbit ?? 0;
      entry.samples += 1;
      entry.paused = entry.paused || Boolean(record.port_output_paused);
      edges.set(id, entry);
    }
    return edges;
  },

  /**
   * The canvas edge a port sample belongs to.
   *
   * @param {Object} record - One port sample
   * @returns {?string} The edge id, or null when either end has no name
   */
  edgeId(record) {
    const source = this.nodeId(record.switch_id);
    const target = this.nodeId(record.target_index);
    return source === null || target === null ? null : `${source}->${target}`;
  },

  /** Push the current window's state onto the graph. */
  paint() {
    if (!this.cy) {
      return;
    }
    const nodes = this.switchState();
    const edges = this.edgeState();
    const ceiling = this.colorCeiling() ?? maxOf(edges, (entry) => entry.sent);
    this.cy.batch(() => {
      this.paintNodes(nodes);
      this.paintEdges(edges, ceiling);
    });
  },

  /**
   * Color each switch by how full its buffer was.
   *
   * @param {Map<string, number>} nodes - Occupancy fraction keyed by node id
   */
  paintNodes(nodes) {
    for (const node of this.cy.nodes()) {
      const occupancy = nodes.get(node.id()) ?? null;
      // One call per element: each `data(key, value)` invalidates the element's
      // style on its own, which is the difference between a frame and a stutter
      // on a topology of any size.
      node.data({
        occupancy,
        stateColor: occupancy === null ? null : viridis(occupancy),
      });
    }
  },

  /**
   * Color and weight each link by what crossed it.
   *
   * @param {Map<string, Object>} edges - State keyed by edge id
   * @param {number} ceiling - The mbit a full-color link stands for
   */
  paintEdges(edges, ceiling) {
    for (const edge of this.cy.edges()) {
      const entry = edges.get(edge.id());
      const sent = entry?.sent ?? 0;
      const share = ceiling > 0 ? Math.min(sent / ceiling, 1) : 0;
      edge.data({
        sent: entry ? sent : null,
        queued: entry?.samples ? entry.queued / entry.samples : null,
        paused: Boolean(entry?.paused),
        stateColor: entry ? viridis(share) : null,
        stateWidth: MIN_EDGE_WIDTH + share * (MAX_EDGE_WIDTH - MIN_EDGE_WIDTH),
      });
    }
  },

  /** Colors for the legend, so the reader knows which end is busy. */
  get rampStops() {
    return [0, 0.25, 0.5, 0.75, 1].map(viridis);
  },

  get pausedColor() {
    return PAUSED_COLOR;
  },

  get borderColor() {
    return THEME.switchBorder;
  },
});

/**
 * The largest value any entry of a map yields.
 *
 * @param {Map} entries - The entries to measure
 * @param {Function} of - Returns the value to compare
 * @returns {number} The maximum, or 0 when there is nothing
 */
function maxOf(entries, of) {
  let max = 0;
  for (const entry of entries.values()) {
    max = Math.max(max, of(entry));
  }
  return max;
}
