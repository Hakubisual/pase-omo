/**
 * Recording doubles for the two plugin contexts. They capture WHAT a contribution
 * function registers so a test can assert the whole manifest at once, which is the
 * only place a duplicate id across merged domains becomes visible.
 */
export type ClientRecording = {
  panels: string[];
  sidebar: string[];
  commands: string[];
  surfaces: string[];
  settings: string[];
  slashCommands: string[];
  pills: string[];
  headerButtons: string[];
  renderers: string[];
  transformers: string[];
  themes: string[];
  attachmentSources: string[];
  titles: string[];
  released: number;
  /** Every registration key handed out, in order. */
  registered: string[];
  /** Registration keys whose remover has not been called. Empty == nothing leaked. */
  outstanding: Set<string>;
};

export type AgentStub = { id: string; provider?: string | null; workspaceId?: string | null };

export function recordingClient(options: { agents?: AgentStub[] } = {}) {
  const rec: ClientRecording = {
    panels: [], sidebar: [], commands: [], surfaces: [], settings: [], slashCommands: [],
    pills: [], headerButtons: [], renderers: [], transformers: [], themes: [],
    attachmentSources: [], titles: [], released: 0,
    registered: [], outstanding: new Set<string>(),
  };
  // One remover per registration, each idempotent, exactly as Paseo promises.
  // A single shared counter cannot tell "every handle was released" from "one
  // handle was released twice while another leaked".
  const track = (key: string) => {
    rec.registered.push(key);
    rec.outstanding.add(key);
    return () => {
      if (!rec.outstanding.delete(key)) return;
      rec.released += 1;
    };
  };
  const button = (key: string) => {
    const remove = track(key);
    return { update: () => {}, remove };
  };
  const agents = options.agents ?? [];
  const listeners: ((u: unknown) => void)[] = [];

  const ctx = {
    addWorkspacePanel(c: { id: string; title: string }) { rec.panels.push(c.id); rec.titles.push(`panel:${c.title}`); return track(`panel:${c.id}`); },
    addSidebarItem(c: { id: string; title: string }) { rec.sidebar.push(c.id); rec.titles.push(`sidebar:${c.title}`); return track(`sidebar:${c.id}`); },
    addCommandCenterItem(c: { id: string; title: string }) { rec.commands.push(c.id); rec.titles.push(`command:${c.title}`); return track(`command:${c.id}`); },
    addSurface(id: string) { rec.surfaces.push(id); return track(`surface:${id}`); },
    addSettingsScreen(c: { id: string }) { rec.settings.push(c.id); return track(`settings:${c.id}`); },
    addSlashCommand(c: { name: string }) { rec.slashCommands.push(c.name); return track(`slash:${c.name}`); },
    addComposerPill(c: { id: string; agentId: string }) { rec.pills.push(`${c.id}:${c.agentId}`); return button(`pill:${c.id}:${c.agentId}`); },
    addHeaderButton(c: { id: string }) { rec.headerButtons.push(c.id); return button(`header:${c.id}`); },
    addTimelineRenderer(c: { kind: string; version: number }) { rec.renderers.push(`${c.kind}@${c.version}`); return track(`renderer:${c.kind}@${c.version}`); },
    addTimelineTransformer(c: { id: string }) { rec.transformers.push(c.id); return track(`transformer:${c.id}`); },
    addTheme(c: { id: string }) { rec.themes.push(c.id); return track(`theme:${c.id}`); },
    addAttachmentSource(c: { id: string }) { rec.attachmentSources.push(c.id); return track(`attachment:${c.id}`); },
    openPanel() {},
    openSurface() {},
    openSettings() {},
    rpc: async () => ({ rows: [] }),
    paseo: {
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
        subscribe(listener: (u: unknown) => void) {
          listeners.push(listener);
          for (const agent of agents) listener({ kind: "upsert", agent });
          return () => { listeners.splice(listeners.indexOf(listener), 1); };
        },
      },
    },
    emit(update: unknown) { for (const l of [...listeners]) l(update); },
    listenerCount: () => listeners.length,
  };
  return { ctx, rec };
}

export type ServerRecording = {
  handlers: string[];
  providers: number;
  events: string[];
  befores: string[];
  settings: number;
  released: number;
  /** Subscription keys whose release has not been called. Empty == nothing leaked. */
  outstanding: Set<string>;
};

export function recordingServer() {
  const rec: ServerRecording = {
    handlers: [], providers: 0, events: [], befores: [], settings: 0, released: 0,
    outstanding: new Set<string>(),
  };
  // Per-subscription idempotent release, for the same reason as the client side.
  const release = (key: string) => {
    rec.outstanding.add(key);
    return () => {
      if (!rec.outstanding.delete(key)) return;
      rec.released += 1;
    };
  };
  const ctx = {
    handle(contract: { name: string }) { rec.handlers.push(contract.name); },
    registerProvider() { rec.providers += 1; },
    registerSettings() { rec.settings += 1; },
    on(event: string) { rec.events.push(event); return release(`on:${event}`); },
    before(event: string) { rec.befores.push(event); return release(`before:${event}`); },
  };
  return { ctx, rec };
}

export const duplicates = (values: readonly string[]): string[] =>
  [...new Set(values.filter((v, i) => values.indexOf(v) !== i))].sort();
