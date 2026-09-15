import type { PluginTheme } from "@getpaseo/plugin";
import type React from "react";
import { beforeEach, expect, test, vi } from "vitest";

/**
 * The global DAG surface used to open on an empty box that told the user to
 * type an absolute project path by hand. Typing `E:/DEV/...` into a phone to
 * see your own sessions is not a feature, so the surface now opens on the most
 * recent OmO project the daemon knows about.
 */

const harness = vi.hoisted(() => ({
  projects: [] as Array<{ cwd: string; sessionCount: number; updatedAt: string }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: () => {},
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(value: T) => ({ current: value }),
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      () => {},
    ],
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data: options.queryKey[1] === "projects" ? { projects: harness.projects } : undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => async () => ({}),
  useWorkspace: () => "",
}));

import { DagGlobalSurface, DagMainView } from "./dag.js";

const theme: PluginTheme = {
  colors: {
    surface0: "#fff",
    surface1: "#f8f8f8",
    surface2: "#eee",
    border: "#ddd",
    foreground: "#111",
    foregroundMuted: "#777",
    accent: "#1677ff",
    accentForeground: "#fff",
    statusSuccess: "#0a0",
    statusWarning: "#a60",
    statusDanger: "#c00",
  },
};

const hostProps = {
  theme,
  host: { id: "host-1", label: "Host" },
  layout: { compact: false, platform: "web" as const },
};

function elements(node: unknown): Array<React.ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object") return [];
  const element = node as React.ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props?.children)];
}

function renderedText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (node === null || typeof node !== "object") return "";
  return renderedText((node as React.ReactElement<Record<string, unknown>>).props?.children);
}

beforeEach(() => {
  harness.projects = [
    { cwd: "E:/DEV/om-pase-o", sessionCount: 12, updatedAt: "2026-09-15T04:59:00.000Z" },
    { cwd: "E:/DEV/other", sessionCount: 3, updatedAt: "2026-09-10T01:00:00.000Z" },
  ];
});

test("the surface opens on the most recent OmO project instead of an empty path box", () => {
  const surface = DagGlobalSurface(hostProps as Parameters<typeof DagGlobalSurface>[0]);

  const main = elements(surface).find((element) => element.type === DagMainView);
  expect((main?.props as { cwd?: string } | undefined)?.cwd).toBe("E:/DEV/om-pase-o");

  const input = elements(surface).find((element) => element.type === "TextInput");
  expect((input?.props as { value?: string } | undefined)?.value).toBe("E:/DEV/om-pase-o");
});

test("every known project is offered as a one-tap shortcut", () => {
  const surface = DagGlobalSurface(hostProps as Parameters<typeof DagGlobalSurface>[0]);
  const text = renderedText(surface);

  for (const project of harness.projects) expect(text).toContain(project.cwd.split("/").pop() ?? project.cwd);

  const shortcuts = elements(surface).filter(
    (element) => element.type === "Pressable" && String(element.props.accessibilityLabel ?? "").includes("프로젝트 선택"),
  );
  expect(shortcuts).toHaveLength(harness.projects.length);
});

test("a long project list stays a header, not the whole first screen", () => {
  // 20 chips filled an entire phone screen and pushed the sessions below the
  // fold, which is the opposite of the tidy surface this is meant to be.
  harness.projects = Array.from({ length: 20 }, (_, index) => ({
    cwd: `E:/DEV/project-${index}`,
    sessionCount: index,
    updatedAt: `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));

  const surface = DagGlobalSurface(hostProps as Parameters<typeof DagGlobalSurface>[0]);
  const shortcuts = elements(surface).filter(
    (element) => element.type === "Pressable" && String(element.props.accessibilityLabel ?? "").includes("프로젝트 선택"),
  );

  expect(shortcuts.length).toBeLessThanOrEqual(6);
  // The one currently being shown is always reachable without expanding.
  expect(
    shortcuts.some((chip) => String(chip.props.accessibilityLabel).includes("E:/DEV/project-0")),
  ).toBe(true);

  const more = elements(surface).find(
    (element) => element.type === "Pressable" && String(element.props.accessibilityLabel ?? "").includes("프로젝트 더 보기"),
  );
  expect(more).toBeDefined();
});

test("a daemon with no OmO sessions still lets the path be typed", () => {
  harness.projects = [];

  const surface = DagGlobalSurface(hostProps as Parameters<typeof DagGlobalSurface>[0]);
  const main = elements(surface).find((element) => element.type === DagMainView);

  expect((main?.props as { cwd?: string } | undefined)?.cwd).toBe("");
  expect(elements(surface).some((element) => element.type === "TextInput")).toBe(true);
});
