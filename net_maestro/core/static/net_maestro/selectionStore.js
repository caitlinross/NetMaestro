/**
 * Alpine.js store for the switch or link the plots are focused on.
 *
 * The time window answers *when*; this answers *what*. Clicking a link in one
 * plot highlights it in the others and dims what it is not, so four panels read
 * as one instrument rather than four views of the same run.
 *
 * Entities are held as the switch ids the model reports, not names, since that
 * is what every record carries. Views resolve names for display.
 *
 * Selecting a switch also matches the links that touch it, and selecting a link
 * also matches its two endpoints. Picking one end of a path therefore lights up
 * the path rather than one isolated mark.
 */

export const selectionStore = {
  // Run the selection belongs to, so one made on another run does not linger.
  runId: null,
  // { kind: 'switch', id } or { kind: 'link', source, target }, or null for none.
  selected: null,

  /** Whether anything is selected. */
  get active() {
    return this.selected !== null;
  },

  /**
   * Drop a selection that belongs to a run no longer being looked at.
   *
   * @param {?number} runId - The run now loaded
   */
  syncRun(runId) {
    if (runId !== this.runId) {
      this.runId = runId;
      this.selected = null;
    }
  },

  /**
   * Focus one switch, or clear it when it is already the selection.
   *
   * @param {number} id - The switch id the model reports
   */
  toggleSwitch(id) {
    const current = this.selected;
    this.selected = current?.kind === 'switch' && current.id === id ? null : { kind: 'switch', id };
  },

  /**
   * Focus one directed link, or clear it when it is already the selection.
   *
   * @param {number} source - Switch id the link leaves
   * @param {number} target - Switch id the link reaches
   */
  toggleLink(source, target) {
    const current = this.selected;
    const same = current?.kind === 'link' && current.source === source && current.target === target;
    this.selected = same ? null : { kind: 'link', source, target };
  },

  /** Focus nothing, so every plot shows everything again. */
  clear() {
    this.selected = null;
  },

  /**
   * Whether a switch is part of the selection, as itself or as a link endpoint.
   *
   * @param {number} id - The switch id to test
   * @returns {boolean} True when nothing is selected, or this switch is in it
   */
  matchesSwitch(id) {
    const current = this.selected;
    if (!current) {
      return true;
    }
    if (current.kind === 'switch') {
      return current.id === id;
    }
    return current.source === id || current.target === id;
  },

  /**
   * Whether a link is part of the selection, as itself or by touching the
   * selected switch.
   *
   * @param {number} source - Switch id the link leaves
   * @param {number} target - Switch id the link reaches
   * @returns {boolean} True when nothing is selected, or this link is in it
   */
  matchesLink(source, target) {
    const current = this.selected;
    if (!current) {
      return true;
    }
    if (current.kind === 'switch') {
      return current.id === source || current.id === target;
    }
    return current.source === source && current.target === target;
  },

  /**
   * The selection in words, for the control strip.
   *
   * @param {Function} label - Turns a switch id into its name
   * @returns {?string} Text describing the selection, or null when there is none
   */
  describe(label) {
    const current = this.selected;
    if (!current) {
      return null;
    }
    return current.kind === 'switch'
      ? `${label(current.id)}`
      : `${label(current.source)} → ${label(current.target)}`;
  },
};
