/**
 * Alpine.js component for the topology page.
 * Draws the selected topology on a Cytoscape canvas, and backs the dialog that
 * edits it or builds a new one.
 *
 * The drawing itself lives in `graph.js`, shared with the analysis page's
 * network view so both pages render the same graph.
 */
import { createGraph, fitGraph } from './graph.js';

// Prevent an error with the model (`fixed_vector capacity exceeded`)
const MAX_PORTS_PER_SWITCH = 128;

let lastId = 0;
const nextId = () => {
  lastId += 1;
  return `row-${lastId}`;
};

/**
 * Convert an API topology payload into the editor form model.
 *
 * The payload carries links as a flat directed list; the YAML nests them under
 * the switch they leave from, so regroup them that way for editing.
 *
 * Every rate and size is a plain number of gigabits; the unit belongs to the
 * field, and the form shows it as a label beside the input. `label` is the
 * dialog heading, not the topology's own label.
 *
 * @param {Object} topology - Value from the topology detail endpoint
 * @returns {Object} Form model holding every field the YAML file defines
 */
const toForm = (topology) => {
  const switches = topology.switches.map((item) => ({
    id: nextId(),
    name: item.name,
    terminals: item.terminals,
    terminalBandwidth: item.terminal_bandwidth_gbps,
    switchBuffer: item.switch_buffer_gb,
    connections: [],
  }));
  const idByName = new Map(switches.map((item) => [item.name, item.id]));
  for (const link of topology.links) {
    const source = switches.find((item) => item.name === link.source);
    source.connections.push({
      id: nextId(),
      targetId: idByName.get(link.target),
      bandwidth: link.bandwidth_gbps,
    });
  }
  return { name: topology.name, label: `Edit ${topology.label}`, switches };
};

/**
 * Build the empty form the create flow starts from, shaped like `toForm`.
 *
 * No switches, since each one is added from a switch component; no name so Save
 * stays disabled until the user picks one.
 *
 * @returns {Object} Form model for a topology that does not exist yet
 */
const blankForm = () => ({
  name: '',
  label: 'New Topology',
  switches: [],
});

/**
 * Convert the editor form model into a payload for the create endpoint.
 *
 * @param {Object} form - The editor form model
 * @returns {Object} Request body for the topology create endpoint
 */
const toPayload = (form) => {
  const nameById = new Map(form.switches.map((item) => [item.id, item.name.trim()]));
  return {
    name: form.name.trim(),
    switches: form.switches.map((item) => ({
      name: item.name.trim(),
      terminals: item.terminals,
      // biome-ignore-start lint/style/useNamingConvention: the API speaks snake_case
      terminal_bandwidth_gbps: item.terminalBandwidth,
      switch_buffer_gb: item.switchBuffer,
      connections: item.connections.map((connection) => ({
        target: nameById.get(connection.targetId) ?? '',
        bandwidth_gbps: connection.bandwidth,
      })),
      // biome-ignore-end lint/style/useNamingConvention: the API speaks snake_case
    })),
  };
};

/**
 * Report what keeps a form from being a saveable network, if anything.
 *
 * Four things have to hold: two or more switches, a unique name on each of
 * them, at least one connection, and no connection left without a target. A
 * switch with no connections of its own still passes - this is a floor, not a
 * reachability check.
 *
 * @param {Object} form - The editor form model
 * @returns {?string} The first problem found, or null when the form is ready
 */
const findNetworkProblem = (form) => {
  if (!form) {
    return null;
  }
  if (form.switches.length < 2) {
    return 'At least two switches required.';
  }
  if (findSwitchProblems(form).size) {
    return 'Every switch needs a name of its own.';
  }
  const connections = form.switches.flatMap((item) => item.connections);
  if (!connections.length) {
    return 'At least one connection required.';
  }
  if (connections.some((connection) => !connection.targetId)) {
    return 'At least one connection is incomplete.';
  }
  const terminalCount = form.switches.reduce((count, item) => count + item.terminals, 0);
  if (terminalCount < 2) {
    return 'At least two total terminals required.';
  }
  if (
    form.switches.some((item) => item.terminals + item.connections.length > MAX_PORTS_PER_SWITCH)
  ) {
    return `No switch may have more than ${MAX_PORTS_PER_SWITCH} terminals and connections combined.`;
  }
  if (form.switches.some((item) => item.terminalBandwidth <= 0 || item.switchBuffer <= 0)) {
    return 'Terminal bandwidth and switch buffer must be greater than zero.';
  }
  if (connections.some((connection) => connection.bandwidth <= 0)) {
    return 'Every connection needs a bandwidth greater than zero.';
  }
  return null;
};

/**
 * Report which switch names the server would reject, and why.
 *
 * Names become the mapping keys of the YAML file, so each one has to be
 * present and unique. Both switches in a collision are reported, since either
 * one is a reasonable thing to rename.
 *
 * @param {Object} form - The editor form model
 * @returns {Map<string, string>} Problem text keyed by switch id
 */
const findSwitchProblems = (form) => {
  const problems = new Map();
  const idByName = new Map();
  for (const item of form.switches) {
    const name = item.name.trim();
    if (!name) {
      problems.set(item.id, 'Needs a name');
    } else if (idByName.has(name)) {
      problems.set(item.id, 'Name already used');
      problems.set(idByName.get(name), 'Name already used');
    } else if (name.includes(':')) {
      problems.set(item.id, 'No colons in names');
    } else {
      idByName.set(name, item.id);
    }
  }
  return problems;
};

/**
 * Report which switches cannot exchange traffic with the rest of the network.
 *
 * The model routes with a breadth-first search per source and leaves no route
 * where it finds none, then drops that traffic at run time without a word. So
 * every switch has to reach every other one, which holds exactly when a search
 * forwards along the connections and a search backwards against them both
 * reach everything from the same starting switch.
 *
 * @param {Object} form - The editor form model
 * @returns {Array<string>} Names of the stranded switches, empty when all can talk
 */
const findStrandedSwitches = (form) => {
  const [root] = form.switches;
  const outbound = new Map(form.switches.map((item) => [item.id, []]));
  const inbound = new Map(form.switches.map((item) => [item.id, []]));
  for (const item of form.switches) {
    for (const connection of item.connections) {
      outbound.get(item.id).push(connection.targetId);
      inbound.get(connection.targetId)?.push(item.id);
    }
  }

  const reachable = (edges) => {
    const seen = new Set([root.id]);
    const queue = [root.id];
    while (queue.length) {
      for (const next of edges.get(queue.pop())) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  const downstream = reachable(outbound);
  const upstream = reachable(inbound);

  return form.switches
    .filter((item) => !(downstream.has(item.id) && upstream.has(item.id)))
    .map((item) => item.name.trim());
};

/**
 * Pull the message out of a DRF error response.
 *
 * @param {Response} response - The failed fetch response
 * @returns {Promise<string>} A message to show in the dialog
 */
const errorMessage = async (response) => {
  try {
    const body = await response.json();
    const detail = Array.isArray(body) ? body[0] : (body.detail ?? body.non_field_errors?.[0]);
    if (detail) {
      return String(detail);
    }
  } catch {
    // Fall through to the status code.
  }
  return `Request failed with status ${response.status}`;
};

export const topologyCanvas = () => {
  // Outside of the Alpine data object on purpose: With Alpine, its properties
  // are deeply reactive. Wrapping a Cytoscape instance that way seems to break things.
  let cy = null;
  let resizeObserver = null;
  // The container keeps growing after the graph is built. Refit on every
  // resize until the user starts interacting.
  let autoFit = true;

  return {
    loading: false,
    error: null,
    topology: null,
    editor: null,
    saving: false,
    saveError: null,
    switchComponents: [],

    destroy() {
      this.teardown();
    },

    teardown() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      cy?.destroy();
      cy = null;
    },

    /**
     * Load the topology chosen in the dropdown and draw it.
     *
     * @param {HTMLSelectElement} selectEl - The topology dropdown element
     */
    async select(selectEl) {
      const url = selectEl.selectedOptions[0]?.dataset.url;
      this.error = null;
      if (!url) {
        this.teardown();
        this.topology = null;
        return;
      }
      this.loading = true;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        this.topology = await response.json();
      } catch (error) {
        this.teardown();
        this.topology = null;
        this.error = `Could not load topology: ${error.message}`;
        return;
      } finally {
        this.loading = false;
      }
      this.$nextTick(() => this.draw());
    },

    /**
     * Open the dialog on a copy of the selected topology, or on a blank form.
     *
     * A blank form starts out failing the minimum-network check, so the dialog
     * says what it still needs before the user touches anything.
     *
     * @param {boolean} isNew - True to start from a blank form
     */
    async fetchSwitchComponents() {
      const url = this.$root.dataset.componentModelsUrl;
      if (!url) {
        return;
      }
      try {
        const response = await fetch(url);
        if (response.ok) {
          this.switchComponents = await response.json();
        }
      } catch {
        // the dropdown will be empty and show a disabled button.
      }
    },

    async openEditor(isNew) {
      await this.fetchSwitchComponents();
      this.editor = isNew ? blankForm() : toForm(this.topology);
      this.saveError = null;
      this.$refs.editorDialog.showModal();
    },

    /**
     * Add a switch from a custom component, using its defaults.
     *
     * Picks the first free letter A–Z as the name. Pre-fills terminal bandwidth
     * and switch buffer from the component's parameters.
     *
     * @param {Object} editor - The editor form model to rebuild from
     * @param {Object} component - Component model from the API
     */
    addSwitchFromComponent(editor, component) {
      const params = component.parameters || {};
      for (let i = 1; i <= 26; i++) {
        const name = String.fromCharCode(65 + i - 1);
        if (!editor.switches.some((switchItem) => switchItem.name === name)) {
          this.editor = {
            ...editor,
            switches: [
              ...editor.switches,
              {
                id: nextId(),
                name,
                terminals: 1,
                terminalBandwidth: Number(params.terminal_bandwidth) || 100,
                switchBuffer: Number(params.switch_buffer) || 64,
                connections: [],
              },
            ],
          };
          break;
        }
      }
    },

    /**
     * Remove a switch from the editor.
     *
     * Replaces `editor` with the trimmed form, dropping any connection that
     * pointed at the switch along with it.
     *
     * @param {Object} editor - The editor form model to rebuild from
     * @param {string} switchId - Id of the switch to remove
     */
    removeSwitch(editor, switchId) {
      this.editor = {
        ...editor,
        switches: editor.switches
          .filter((switchItem) => switchItem.id !== switchId)
          .map((switchItem) => ({
            ...switchItem,
            connections: switchItem.connections.filter(
              (connection) => connection.targetId !== switchId,
            ),
          })),
      };
    },

    /**
     * Add an outbound connection to one switch, with no target chosen yet.
     *
     * Replaces `editor` with the extended form. The new row has no target yet,
     * which the network check reports until the user picks one.
     *
     * @param {Object} editor - The editor form model to rebuild from
     * @param {string} switchId - Id of the switch the connection leaves from
     */
    addConnection(editor, switchId) {
      this.editor = {
        ...editor,
        switches: editor.switches.map((switchItem) => {
          if (switchItem.id !== switchId) {
            return switchItem;
          }
          return {
            ...switchItem,
            connections: [
              ...switchItem.connections,
              {
                id: nextId(),
                targetId: '',
                bandwidth: 1,
              },
            ],
          };
        }),
      };
    },

    /**
     * Remove one of a switch's outbound connections.
     *
     * Replaces `editor` with the trimmed form. Rows are matched by their own
     * id, so a switch with two rows aimed at the same place loses only the one
     * the user clicked.
     *
     * @param {Object} editor - The editor form model to rebuild from
     * @param {string} switchId - Id of the switch the connection leaves from
     * @param {string} connectionId - Id of the connection to remove
     */
    removeConnection(editor, switchId, connectionId) {
      this.editor = {
        ...editor,
        switches: editor.switches.map((switchItem) => {
          if (switchItem.id !== switchId) {
            return switchItem;
          }
          return {
            ...switchItem,
            connections: switchItem.connections.filter(
              (connection) => connection.id !== connectionId,
            ),
          };
        }),
      };
    },

    /**
     * List the switches a connection may point at.
     *
     * Leaves out the switch itself, and marks targets this switch already
     * points at: two connections to the same place collapse into one entry
     * when the YAML is written.
     *
     * @param {Object} switchItem - The switch the connection leaves from
     * @param {Object} connection - The connection being edited
     * @returns {Array} Candidates with `id`, `name`, and `taken`
     */
    targetOptions(switchItem, connection) {
      const used = new Set(
        switchItem.connections
          .filter((other) => other.id !== connection.id)
          .map((other) => other.targetId),
      );
      return this.editor.switches
        .filter(
          (candidate) => candidate.id !== switchItem.id || candidate.id === connection.targetId,
        )
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          taken: used.has(candidate.id),
        }));
    },

    /**
     * Report whether the name in the editor is already used by a topology.
     *
     * Each topology is a file named after it, so a name can only be used once.
     * The server enforces this too; checking here keeps the Save button from
     * promising something that will fail.
     *
     * @returns {boolean} True when the dropdown already lists this name
     */
    nameTaken() {
      const name = this.editor?.name.trim();
      return [...this.$refs.picker.options].some((option) => option.value === name);
    },

    /**
     * Report whether there are at least two switches present.
     *
     * A topology cannot be created without at least two switches.
     *
     * @returns {boolean} True when there are two or more switches.
     */
    canConnect() {
      if (this.editor?.switches.length > 1) {
        return true;
      }
      return false;
    },

    /**
     * What keeps the editor from being saved, or null when it is ready.
     *
     * A getter, so the dialog can read it while rendering without anything
     * writing state mid-render, and so it re-evaluates as the form changes.
     *
     * @returns {?string} The first problem with the form
     */
    get networkProblem() {
      return findNetworkProblem(this.editor);
    },

    /**
     * Warn about switches the model would never route traffic to or from.
     *
     * The topology still saves: the model loads it and runs, it just discards
     * what it cannot route. Held back until the form is otherwise sound, since
     * a half-built network is stranded by definition.
     *
     * @returns {?string} Warning text, or null when there is nothing to say
     */
    get networkWarning() {
      if (!this.editor || findNetworkProblem(this.editor)) {
        return null;
      }
      const stranded = findStrandedSwitches(this.editor);
      if (!stranded.length) {
        return null;
      }
      return `${stranded.join(', ')} cannot exchange traffic with the rest of the network. The model drops what it cannot route.`;
    },

    /**
     * Report what is wrong with one switch's name, if anything.
     *
     * Read while rendering, so the offending card can mark itself rather than
     * leaving the user to hunt for it.
     *
     * @param {string} switchId - Id of the switch to check
     * @returns {?string} Problem text, or null when the name is fine
     */
    switchProblem(switchId) {
      if (!this.editor) {
        return null;
      }
      return findSwitchProblems(this.editor).get(switchId) ?? null;
    },

    /**
     * Save the editor contents as a new topology, then select and draw it.
     */
    async saveEditor() {
      if (this.saving || !this.editor) {
        return;
      }
      this.saving = true;
      this.saveError = null;
      try {
        const response = await fetch(this.$root.dataset.createUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': this.$root.querySelector('[name=csrfmiddlewaretoken]').value,
          },
          body: JSON.stringify(toPayload(this.editor)),
        });
        if (!response.ok) {
          this.saveError = await errorMessage(response);
          return;
        }
        const saved = await response.json();
        this.$refs.editorDialog.close();
        this.selectSaved(saved);
      } catch (error) {
        this.saveError = `Could not save topology: ${error.message}`;
      } finally {
        this.saving = false;
      }
    },

    /**
     * Add a freshly saved topology to the dropdown and preview it.
     *
     * @param {Object} saved - Value from the topology create endpoint
     */
    selectSaved(saved) {
      const picker = this.$refs.picker;
      const option = new Option(`${saved.label} — ${saved.summary}`, saved.name, false, true);
      option.dataset.url = saved.url;
      picker.add(option);
      this.select(picker);
    },

    /**
     * Render the loaded topology onto the canvas.
     */
    draw() {
      const container = this.$refs.canvas;
      if (!(container && this.topology)) {
        return;
      }
      this.teardown();
      autoFit = true;
      cy = createGraph(container, this.topology);

      resizeObserver = new ResizeObserver(() => {
        if (autoFit) {
          this.fitToView();
        } else {
          cy?.resize();
        }
      });
      resizeObserver.observe(container);

      const releaseViewport = () => {
        autoFit = false;
      };
      container.addEventListener('pointerdown', releaseViewport, { once: true });
      container.addEventListener('wheel', releaseViewport, { once: true, passive: true });
    },

    /**
     * Re-fit the graph into the visible canvas area.
     */
    fitToView() {
      fitGraph(cy);
    },
  };
};
