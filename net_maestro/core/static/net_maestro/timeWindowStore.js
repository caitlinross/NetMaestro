/**
 * Alpine.js store for the slice of virtual time the plots share.
 *
 * A run's plots aggregate over every sample it holds, which answers what the run
 * did but not when it did it. Setting a window narrows all of them to one slice
 * of virtual time; playing walks that slice forward on a timer, so the run
 * replays rather than being summed. With no window set every plot aggregates
 * over the whole run, which is where a freshly selected run starts.
 *
 * Plots report the extent of their own time column as they load, and the store
 * keeps the union. Reporting carries the run id so that selecting another run
 * clears the window without the plots and the controls having to agree on who
 * resets first.
 */

// Wall-clock milliseconds a slice is shown for while playing.
const DEFAULT_FRAME_MS = 200;

// How many of the run's own samples one slice covers. Slicing finer than the
// run was sampled leaves slices holding nothing at all, so the run's sampling
// is the floor: one sample per slice by default, coarser on request.
const SAMPLES_PER_SLICE = [1, 2, 5, 10];

export const timeWindowStore = {
  // Run the bounds belong to, so a new run's first report clears the old one.
  runId: null,
  // Full extent of the run's virtual time as { min, max }, or null before any
  // plot has reported one.
  bounds: null,
  // The active slice as { min, max }, or null while the plots aggregate over the
  // whole run.
  window: null,
  playing: false,
  frameMs: DEFAULT_FRAME_MS,
  // How many distinct sample times the run holds, as the most any one plot
  // reported. Slicing is derived from this rather than from a fixed number, so
  // a coarsely sampled run does not replay through empty slices.
  sampleCount: 0,
  samplesPerSlice: 1,
  // How to turn the run's raw time values into something readable.
  unit: { scale: 1, suffix: '' },
  // Whether the slice width is the user's pick rather than the default, so a
  // plot reporting its extent later does not undo their choice.
  sliceChosen: false,
  // Handle of the play timer, or null when not playing.
  timerId: null,

  /** The slice widths on offer, coarsest sampling last. */
  get sliceOptions() {
    return SAMPLES_PER_SLICE.filter((n) => n === 1 || n < this.sampleCount).map((n) => ({
      samples: n,
      label: n === 1 ? 'Per sample' : `Every ${n} samples`,
    }));
  },

  /** How many slices the run divides into at the chosen detail. */
  get sliceCount() {
    return Math.max(1, Math.ceil(this.sampleCount / this.samplesPerSlice));
  },

  /** The run's full time span, or 0 before any plot has reported bounds. */
  get span() {
    return this.bounds ? this.bounds.max - this.bounds.min : 0;
  },

  /** How wide one slice is, in the units of the run's time column. */
  get sliceWidth() {
    return this.span / this.sliceCount;
  },

  /** True once some plot has reported a usable time extent. */
  get ready() {
    return this.bounds !== null && this.span > 0 && this.sampleCount > 0;
  },

  /**
   * Where the window sits in the run, as a fraction from 0 to 1.
   * Reads 0 while no window is set, which is where playing would start.
   */
  get position() {
    if (!(this.ready && this.window)) {
      return 0;
    }
    const travel = this.span - this.sliceWidth;
    if (travel <= 0) {
      return 0;
    }
    return (this.window.min - this.bounds.min) / travel;
  },

  /** The window as text for the controls, or a note that nothing is narrowed. */
  get label() {
    if (!this.window) {
      return 'Whole run';
    }
    return `${format(this.window.min, this.unit)} – ${format(this.window.max, this.unit)}${this.unit.suffix}`;
  },

  /**
   * Take one plot's view of how far the run's time column runs.
   *
   * The store keeps the union across plots, so a run whose plots read different
   * datasets still scrubs over all of it. A report naming another run replaces
   * the bounds rather than widening them.
   *
   * @param {?number} runId - The run the extent was measured on
   * @param {Object} extent - What the plot found
   * @param {number} extent.min - Lowest time value the plot holds
   * @param {number} extent.max - Highest time value the plot holds
   * @param {number} [extent.samples] - How many distinct sample times it holds
   * @param {{scale: number, suffix: string}} [extent.unit] - How to show those values
   */
  reportBounds(runId, { min, max, samples = 0, unit = { scale: 1, suffix: '' } }) {
    if (runId !== this.runId) {
      this.pause();
      this.runId = runId;
      this.bounds = null;
      this.window = null;
      this.sampleCount = 0;
      this.samplesPerSlice = 1;
      this.sliceChosen = false;
    }
    if (!(Number.isFinite(min) && Number.isFinite(max)) || max <= min) {
      return;
    }
    this.bounds = this.bounds
      ? { min: Math.min(this.bounds.min, min), max: Math.max(this.bounds.max, max) }
      : { min, max };
    this.sampleCount = Math.max(this.sampleCount, samples);
    this.unit = unit;
    if (!this.sliceChosen) {
      // Start on the widest slice. A run sampled finer than the quantity being
      // plotted changes - the model dumps a whole fluid interval's traffic on
      // one sample, and samples ten times per interval - leaves the narrow
      // slices empty, so playing from the default would show nothing moving.
      this.samplesPerSlice = this.sliceOptions.at(-1)?.samples ?? 1;
    }
  },

  /**
   * Narrow the plots to one slice of time.
   *
   * @param {number} min - Start of the slice
   * @param {number} max - End of the slice
   */
  setWindow(min, max) {
    this.window = { min, max };
  },

  /** Widen back to the whole run, stopping playback. */
  clear() {
    this.pause();
    this.window = null;
  },

  /**
   * Put the window at a fraction of the way through the run.
   *
   * @param {number} fraction - Position from 0 (start) to 1 (end)
   */
  seek(fraction) {
    if (!this.ready) {
      return;
    }
    this.seekTime(
      this.bounds.min + clamp(fraction, 0, 1) * Math.max(this.span - this.sliceWidth, 0),
    );
  },

  /**
   * Put the window at a point in the run, so a plot can hand over a time the
   * user picked off its own axis.
   *
   * @param {number} time - Where the slice should start
   */
  seekTime(time) {
    if (!this.ready) {
      return;
    }
    const width = this.sliceWidth;
    const last = Math.max(this.bounds.min, this.bounds.max - width);
    const start = clamp(time, this.bounds.min, last);
    this.setWindow(start, start + width);
  },

  /**
   * Choose how many of the run's samples one slice covers, keeping the window
   * where it starts.
   *
   * @param {number} samples - Samples per slice
   */
  setSamplesPerSlice(samples) {
    this.samplesPerSlice = samples;
    this.sliceChosen = true;
    if (this.window) {
      this.setWindow(this.window.min, this.window.min + this.sliceWidth);
    }
  },

  /**
   * Move to the next slice, stopping once the window reaches the run's end.
   *
   * The last slice is pinned to the end rather than allowed to run past it, so
   * playback finishes on a full slice of real samples.
   */
  advance() {
    if (!this.ready) {
      this.pause();
      return;
    }
    const width = this.sliceWidth;
    const start = this.window ? this.window.min + width : this.bounds.min;
    if (start + width >= this.bounds.max) {
      this.setWindow(Math.max(this.bounds.min, this.bounds.max - width), this.bounds.max);
      this.pause();
      return;
    }
    this.setWindow(start, start + width);
  },

  /**
   * Start walking the window forward.
   *
   * Playing from the end of the run starts over, so the button reads as replay
   * rather than doing nothing.
   */
  play() {
    if (this.playing || !this.ready) {
      return;
    }
    if (this.window && this.window.max >= this.bounds.max) {
      this.window = null;
    }
    this.playing = true;
    this.timerId = setInterval(() => this.advance(), this.frameMs);
    // Show the first slice now rather than after one frame of nothing.
    this.advance();
  },

  /** Stop playing, leaving the window where it reached. */
  pause() {
    this.playing = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  },

  /** Play if stopped, stop if playing. */
  toggle() {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  },
};

/**
 * Hold a number inside a range.
 *
 * @param {number} value - The number to clamp
 * @param {number} min - Lowest allowed value
 * @param {number} max - Highest allowed value
 * @returns {number} The clamped value
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Render a time value short enough for the window label.
 *
 * Virtual time arrives in whatever unit the run's time column uses, and spans
 * range from fractions to billions, so pick a notation that fits either.
 *
 * @param {number} value - The time value
 * @param {{scale: number}} unit - How to scale it for display
 * @returns {string} Text for the label
 */
function format(value, unit) {
  const scaled = value * unit.scale;
  const size = Math.abs(scaled);
  if (size !== 0 && (size < 0.01 || size >= 1e6)) {
    return scaled.toExponential(2);
  }
  return scaled.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
