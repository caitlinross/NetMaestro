/**
 * Drawing a topology on a Cytoscape canvas.
 *
 * Shared by the topology page, which draws a preset being edited, and the
 * network view on the analysis page, which draws the same graph carrying a run's
 * state. Both get the same nodes, edges and layout; the network view adds style
 * rules of its own on top.
 */
import cytoscape from 'cytoscape';

/**
 * Canvas colors
 */
export const THEME = {
  switchFill: '#1d232a',
  switchBorder: '#00b5ff',
  label: '#ffffff',
  link: '#6b7683',
  linkLabel: '#a6adba',
  terminal: '#00b5ff',
  terminalOverflow: '#a6adba',
};

const FIT_PADDING = 30;
const MAX_FIT_ZOOM = 1.5;

// Terminal badges drawn inside each node.
const STRIP_HEIGHT = 16;
const TERMINAL_ICON_LIMIT = 6;
const ICON_WIDTH = 9;
const ICON_HEIGHT = 8;
const ICON_GAP = 3;
const OVERFLOW_TEXT_WIDTH = 22;
const MAX_ICONS_WIDTH = TERMINAL_ICON_LIMIT * ICON_WIDTH + (TERMINAL_ICON_LIMIT - 1) * ICON_GAP;
const STRIP_WIDTH = MAX_ICONS_WIDTH + ICON_GAP + OVERFLOW_TEXT_WIDTH;
const NODE_WIDTH = STRIP_WIDTH + 16;
const NODE_HEIGHT = 64;

/**
 * Draw a node's terminals as a strip of small icons.
 *
 * Switches with more terminals than fit are drawn up to the limit followed by
 * a "+N" count, so it stays readable.
 *
 * @param {number} count - Number of terminals attached to the switch
 * @returns {string} SVG data URI, or 'none' when the switch has no terminals
 */
const terminalStrip = (count) => {
  if (!count) {
    return 'none';
  }
  const shown = Math.min(count, TERMINAL_ICON_LIMIT);
  const overflow = count - shown;
  const iconsWidth = shown * ICON_WIDTH + (shown - 1) * ICON_GAP;
  const totalWidth = iconsWidth + (overflow ? ICON_GAP + OVERFLOW_TEXT_WIDTH : 0);
  const left = (STRIP_WIDTH - totalWidth) / 2;
  const top = (STRIP_HEIGHT - ICON_HEIGHT) / 2;

  const icons = Array.from({ length: shown }, (_, index) => {
    const x = left + index * (ICON_WIDTH + ICON_GAP);
    return `<rect x="${x}" y="${top}" width="${ICON_WIDTH}" height="${ICON_HEIGHT}" rx="2" fill="${THEME.terminal}"/>`;
  }).join('');

  const overflowLabel = overflow
    ? `<text x="${left + iconsWidth + ICON_GAP}" y="${STRIP_HEIGHT - 4}" font-family="sans-serif" font-size="10" fill="${THEME.terminalOverflow}">+${overflow}</text>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STRIP_WIDTH}" height="${STRIP_HEIGHT}" viewBox="0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}">${icons}${overflowLabel}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

/**
 * Build the Cytoscape stylesheet for the topology graph.
 *
 * @returns {Array} Cytoscape style entries
 */
export const graphStyle = () => [
  {
    selector: 'node',
    style: {
      shape: 'round-rectangle',
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      'background-color': THEME.switchFill,
      'border-color': THEME.switchBorder,
      'border-width': 2,
      label: 'data(name)',
      color: THEME.label,
      'font-size': 14,
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-y': -8,
      'background-image': 'data(terminalIcons)',
      'background-fit': 'none',
      'background-width': `${STRIP_WIDTH}px`,
      'background-height': `${STRIP_HEIGHT}px`,
      'background-position-x': '50%',
      'background-position-y': '78%',
      'background-clip': 'none',
      'background-image-containment': 'over',
    },
  },
  {
    selector: 'edge',
    style: {
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'line-color': THEME.link,
      'target-arrow-color': THEME.link,
      width: 2,
      label: 'data(bandwidthLabel)',
      color: THEME.linkLabel,
      'font-size': 10,
      'text-rotation': 'autorotate',
      'text-background-color': THEME.switchFill,
      'text-background-opacity': 0.85,
      'text-background-padding': 2,
    },
  },
];

/**
 * Convert an API topology payload into Cytoscape elements.
 *
 * Edge ids are `source->target` by switch name, which is how a run's per-port
 * samples are matched to the link they crossed.
 *
 * @param {Object} topology - Value from the topology detail endpoint
 * @returns {Array} Cytoscape element definitions
 */
export const toElements = (topology) => [
  ...topology.switches.map((item) => ({
    data: {
      id: item.name,
      name: item.name,
      terminals: item.terminals,
      terminalIcons: terminalStrip(item.terminals),
      terminalBandwidth: item.terminal_bandwidth_gbps,
      switchBuffer: item.switch_buffer_gb,
    },
  })),
  ...topology.links.map((link) => ({
    data: {
      id: `${link.source}->${link.target}`,
      source: link.source,
      target: link.target,
      bandwidth: link.bandwidth_gbps,
      bandwidthLabel: link.bandwidth_label,
    },
  })),
];

/**
 * Re-fit a graph into the visible canvas area.
 *
 * @param {Object} cy - The Cytoscape instance
 */
export const fitGraph = (cy) => {
  if (!cy) {
    return;
  }
  cy.resize();
  cy.fit(undefined, FIT_PADDING);
  if (cy.zoom() > MAX_FIT_ZOOM) {
    cy.zoom(MAX_FIT_ZOOM);
    cy.center();
  }
};

/**
 * Draw a topology and lay it out, fitting it once the layout settles.
 *
 * @param {HTMLElement} container - Element to draw into
 * @param {Object} topology - Value from the topology detail endpoint
 * @param {Array} extraStyle - Style entries appended after the base stylesheet
 * @returns {Object} The Cytoscape instance
 */
export const createGraph = (container, topology, extraStyle = []) => {
  const cy = cytoscape({
    container,
    elements: toElements(topology),
    style: [...graphStyle(), ...extraStyle],
  });

  const layout = cy.layout({
    name: 'cose',
    animate: false,
    nodeDimensionsIncludeLabels: true,
    fit: false,
  });
  layout.one('layoutstop', () => fitGraph(cy));
  layout.run();

  return cy;
};
