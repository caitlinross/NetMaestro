/**
 * Per-simulation-type plot settings, keyed by Run.simulation_type.
 * Add an entry when a new simulation type is added, affecting the generation of plots
 */

// Event trace, CODES model stats and ROSS engine stats: produced by PHOLD and ingested ESnet runs.
const ROSS_PROFILE = {
  heatmap: {
    dataset: 'event',
    title: 'Event Heatmap',
    sourceKey: 'source_lp',
    destKey: 'dest_lp',
    xTitle: 'Receiving LP ID',
    yTitle: 'Sending LP ID',
    metrics: [
      { key: 'num_messages', label: 'Num Messages', aggregate: 'count' },
      {
        key: 'bytes_sent',
        label: 'Bytes Sent (not available)',
        disabled: true,
        tooltip: 'Message size data not available in current event trace format',
      },
    ],
  },
  networkTime: {
    dataset: 'model',
    groupBy: 'lp_id',
    excludedColumns: ['lp_id', 'component_id', 'real_time', 'virtual_time'],
    timeAxes: [
      { key: 'virtual_time', label: 'Virtual Time' },
      { key: 'real_time', label: 'Real Time' },
    ],
    defaults: { x: 'virtual_time', y: 'send_count' },
  },
  simulation: {
    dataset: 'ross',
    groupBy: 'PE_ID',
    excludedColumns: ['PE_ID', 'real_time', 'virtual_time'],
    timeAxes: [
      { key: 'virtual_time', label: 'Virtual Time' },
      { key: 'real_time', label: 'Real Time' },
    ],
    scatterDefaults: { x: 'events_processed', y: 'events_rolled_back' },
    timeDefaults: { x: 'virtual_time', y: 'events_processed' },
    parallelDimensions: [
      { key: 'PE_ID', label: 'PE ID' },
      { key: 'events_processed', label: 'Events Processed' },
      { key: 'events_rolled_back', label: 'Events Rolled Back' },
      { key: 'total_rollbacks', label: 'Total Rollbacks' },
      { key: 'secondary_rollbacks', label: 'Secondary Rollbacks' },
    ],
  },
};

// Fluid-flow WAN model stats: switch, per-port and terminal samples from the analysis LPs.
const FFW_SAMPLE_COLUMNS = [
  'stats_type',
  'ts',
  'real_time',
  'gvt',
  'end_time',
  'peid',
  'kpid',
  'lpid',
];
const FFW_TIME_AXES = [
  { key: 'ts', label: 'Virtual Time', statsType: 'vt' },
  { key: 'real_time', label: 'Real Time (s)', statsType: 'rt' },
];
// biome-ignore lint/style/useNamingConvention: matches the API's ?stats_type= query param
const FFW_PARAMS = { stats_type: 'vt' };
// Time plots fetch both clocks and pick rows per x-axis (see FFW_TIME_AXES statsType).
// biome-ignore lint/style/useNamingConvention: matches the API's ?stats_type= query param
const FFW_TIME_PARAMS = { stats_type: 'vt,rt' };

const FFW_PROFILE = {
  heatmap: {
    dataset: 'ffw-ports',
    params: FFW_PARAMS,
    title: 'Switch Link Heatmap',
    sourceKey: 'switch_id',
    destKey: 'target_index',
    // Both axes are switch ids, so both read better as the topology's switch names.
    axisLabels: 'switches',
    // Switch-to-switch links only; terminal-facing ports would mix terminal and switch IDs.
    include: (record) => !record.is_terminal,
    // A port's sample counts what its own switch sent towards the target, so the row
    // is the sender and the column the receiver.
    xTitle: 'Receiving Switch',
    yTitle: 'Sending Switch',
    metrics: [
      { key: 'port_sent_mbit', label: 'Sent (Mbit)', aggregate: 'sum' },
      { key: 'port_queued_mbit', label: 'Queued (Mbit)', aggregate: 'sum' },
      { key: 'port_pause_time_ns', label: 'Pause Time (ns)', aggregate: 'sum' },
    ],
  },
  networkTime: {
    dataset: 'ffw-terminals',
    timeParams: FFW_TIME_PARAMS,
    groupBy: 'terminal_id',
    excludedColumns: [...FFW_SAMPLE_COLUMNS, 'terminal_id', 'attached_switch'],
    timeAxes: FFW_TIME_AXES,
    defaults: { x: 'ts', y: 'send_rate_sum_mbps' },
  },
  simulation: {
    dataset: 'ffw-switches',
    params: FFW_PARAMS,
    timeParams: FFW_TIME_PARAMS,
    groupBy: 'switch_id',
    excludedColumns: [...FFW_SAMPLE_COLUMNS, 'switch_id', 'num_ports'],
    timeAxes: FFW_TIME_AXES,
    scatterDefaults: { x: 'shared_buffer_occupancy_mbit', y: 'sent_mbit' },
    timeDefaults: { x: 'ts', y: 'sent_mbit' },
    parallelDimensions: [
      { key: 'switch_id', label: 'Switch ID' },
      { key: 'sent_mbit', label: 'Sent (Mbit)' },
      { key: 'delivered_local_mbit', label: 'Delivered Local (Mbit)' },
      { key: 'dropped_mbit', label: 'Dropped (Mbit)' },
      { key: 'shared_buffer_occupancy_mbit', label: 'Buffer Occupancy (Mbit)' },
      { key: 'pause_frames_sent', label: 'Pause Frames Sent' },
    ],
  },
};

const PLOT_PROFILES = {
  phold: ROSS_PROFILE,
  esnet: ROSS_PROFILE,
  ffw: FFW_PROFILE,
};

/** Return the plot profile for a simulation type, defaulting to the ROSS profile. */
export function plotProfileFor(simulationType) {
  return PLOT_PROFILES[simulationType] ?? ROSS_PROFILE;
}

// Switch samples plotted over time. Switches are model data from the same FFW files as
// terminals and ports, so they belong on the Network Performance tab.
const FFW_SWITCH_TIME = {
  dataset: 'ffw-switches',
  params: FFW_PARAMS,
  timeParams: FFW_TIME_PARAMS,
  groupBy: 'switch_id',
  excludedColumns: [...FFW_SAMPLE_COLUMNS, 'switch_id', 'num_ports'],
  timeAxes: FFW_TIME_AXES,
  defaults: { x: 'ts', y: 'shared_buffer_occupancy_mbit' },
};

// A run can hold both FFW model stats and ROSS engine stats, so each plot slot picks its
// dataset from what the run actually has rather than from the run's simulation type.
//
// `fallbackOnly` sources are used when nothing better has data, but are not offered as a
// choice: FFW switch data backs the simulation slot so that an FFW run with no engine
// stats still fills the Simulation Performance tab.
export const SLOT_SOURCES = {
  heatmap: [
    {
      source: 'ffw-ports',
      dataset: 'ffw-ports',
      label: 'Switch links',
      profile: FFW_PROFILE.heatmap,
    },
    { source: 'event', dataset: 'event', label: 'Events', profile: ROSS_PROFILE.heatmap },
  ],
  networkTime: [
    {
      source: 'ffw-switches',
      dataset: 'ffw-switches',
      label: 'Switches',
      profile: FFW_SWITCH_TIME,
    },
    {
      source: 'ffw-terminals',
      dataset: 'ffw-terminals',
      label: 'Terminals',
      profile: FFW_PROFILE.networkTime,
    },
    { source: 'model', dataset: 'model', label: 'Model stats', profile: ROSS_PROFILE.networkTime },
  ],
  simulation: [
    {
      source: 'ross',
      dataset: 'ross',
      label: 'Engine (PE/KP/LP)',
      profile: ROSS_PROFILE.simulation,
    },
    {
      source: 'ffw-switches',
      dataset: 'ffw-switches',
      label: 'Switches',
      profile: FFW_PROFILE.simulation,
      fallbackOnly: true,
    },
  ],
};

/** Sources for a slot that the run has data for, in preference order. */
function resolvableSources(slot, datasets) {
  const options = SLOT_SOURCES[slot] ?? [];
  if (!datasets) {
    return options;
  }
  return options.filter((option) => (datasets[option.dataset] ?? 0) > 0);
}

/**
 * The sources to offer as a choice for a slot. Empty or single-entry means no toggle:
 * fallbackOnly sources never appear, and they are dropped entirely once a real source
 * has data, so the Simulation tab shows engine metrics alone.
 */
export function sourcesForSlot(slot, datasets) {
  const available = resolvableSources(slot, datasets);
  const offered = available.filter((option) => !option.fallbackOnly);
  return offered.length > 0 ? offered : available;
}

/** Resolve a slot's profile: the chosen source if it has data, else the preferred one. */
export function profileForSlot(slot, datasets, chosenSource) {
  const available = sourcesForSlot(slot, datasets);
  const picked = available.find((option) => option.source === chosenSource) ?? available[0];
  return picked?.profile ?? ROSS_PROFILE[slot] ?? null;
}
