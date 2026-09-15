/** Stable identifiers shared by the client and server bundles. */

/** Plugin id, must match paseo-plugin.json. */
export const PLUGIN_ID = "omo";


/**
 * Provider id contributed by this plugin.
 *
 * This is `omo`, not a suffixed variant, so the agents Paseo lists are exactly
 * OmO's own agents and every surface that matches on the OmO provider (`workers`,
 * the DAG pill, agent profiles saved before this rename) agrees on one id.
 * `omo` is neither a Paseo builtin provider id nor an id configured under
 * `agents.providers` in config.json, which is the pair of collisions the daemon
 * rejects a plugin for.
 */
export const PROVIDER_ID = "omo";

export const PROVIDER_LABEL = "OmO";

/** Workspace tab that renders the OmO task/DAG graph. */
export const DAG_PANEL_ID = "dag";

/** Full-screen sidebar surface for the same graph. */
export const DAG_SURFACE_ID = "dag-global";

/**
 * Agent tab that answers an OmO confirm, select or question request.
 *
 * It lives in the agent context because a pending request always belongs to one
 * agent's run, and it takes the slot the removed workers panel used to occupy.
 */
export const APPROVAL_PANEL_ID = "approvals";


/**
 * Workspace tab that browses sessions, runs and their parallel agents as folders.
 */
export const FOLDERS_PANEL_ID = "folders";
