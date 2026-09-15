export const useRpc = () => async () => ({});
export const useWorkspace = (_id: string, select?: (w: unknown) => unknown) =>
  select ? select({ name: "FREE", cwd: "E:/DEV/FREE" }) : "E:/DEV/FREE";
export const useAgent = (_id: string, select?: (a: unknown) => unknown) =>
  select ? select({ id: "agent-1", provider: "omo" }) : undefined;
export const usePaseo = () => ({ agents: { list: async () => ({ entries: [] }), subscribe: () => () => {} } });
