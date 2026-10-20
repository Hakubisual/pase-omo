import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { WorkerOutput, WorkerOutputEntry } from "../shared/dag.js";

export type OutputRow =
  | { id: string; type: "assistant" | "final"; text: string; truncated: boolean }
  | { id: string; type: "tool"; name: string; results: WorkerOutputEntry[]; callRecorded: boolean };

/** Pair only explicit tool-call IDs; list order and tool names are not identity. */
export function outputRows(entries: WorkerOutputEntry[]): OutputRow[] {
  const rows: OutputRow[] = [], calls = new Map<string, Extract<OutputRow, { type: "tool" }>>();
  for (const entry of entries) {
    if (entry.type === "assistant" || entry.type === "final") {
      rows.push({ id: entry.id, type: entry.type, text: entry.text, truncated: entry.truncated === true });
    } else if (entry.type === "tool_call") {
      const row: Extract<OutputRow, { type: "tool" }> = { id: entry.id, type: "tool", name: entry.toolName || "Unknown tool", results: [], callRecorded: true };
      rows.push(row); if (entry.toolCallId) calls.set(entry.toolCallId, row);
    } else {
      let row = entry.toolCallId ? calls.get(entry.toolCallId) : undefined;
      if (!row) {
        row = { id: entry.id, type: "tool", name: entry.toolName || "Tool result", results: [], callRecorded: false };
        rows.push(row); if (entry.toolCallId) calls.set(entry.toolCallId, row);
      }
      row.results.push(entry);
    }
  }
  return rows;
}

const monospace = Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "monospace";

/** A small literal renderer, not HTML: no image fetching, links or executable markup. */
function InlineText({ text, theme }: { text: string; theme: PluginTheme }) {
  return <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 19 }}>
    {text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => part.startsWith("**") && part.endsWith("**")
      ? <Text key={index} style={{ fontWeight: "600" }}>{part.slice(2, -2)}</Text>
      : part.startsWith("`") && part.endsWith("`") ? <Text key={index} style={{ fontFamily: monospace, backgroundColor: theme.colors.surface2 }}>{part.slice(1, -1)}</Text> : part)}
  </Text>;
}

export function AssistantOutput({ text, theme }: { text: string; theme: PluginTheme }) {
  const blocks: Array<{ type: "text" | "code"; text: string }> = [];
  let code = false, lines: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (lines.length) blocks.push({ type: code ? "code" : "text", text: lines.join("\n") });
      code = !code; lines = [];
    } else lines.push(line);
  }
  if (lines.length) blocks.push({ type: code ? "code" : "text", text: lines.join("\n") });
  return <View style={{ gap: 6 }}>
    {blocks.map((block, i) => block.type === "code" ? <ScrollView key={i} style={{ backgroundColor: theme.colors.surface0, borderRadius: 4, padding: 8, maxHeight: 220 }}><ScrollView horizontal>
      <Text selectable style={{ fontFamily: monospace, fontSize: 12, lineHeight: 18, color: theme.colors.foreground }}>{block.text}</Text>
    </ScrollView>
    </ScrollView> : <View key={i} style={{ gap: 3 }}>{block.text.split("\n").map((line, n) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      return heading ? <Text key={n} selectable style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", marginTop: 4 }}>{heading[1]}</Text>
        : <InlineText key={n} text={bullet ? `• ${bullet[1]}` : line} theme={theme} />;
    })}</View>)}
  </View>;
}

export function ToolOutput({ row, theme }: { row: Extract<OutputRow, { type: "tool" }>; theme: PluginTheme }) {
  const [expanded, setExpanded] = useState(false);
  const error = row.results.some(entry => entry.isError === true);
  const text = row.results.map(entry => entry.text).join("\n\n");
  return <View style={{ borderWidth: 1, borderColor: error ? theme.colors.statusDanger : theme.colors.border, borderRadius: 6, overflow: "hidden" }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} tool output: ${row.name}`}
      accessibilityState={{ expanded }} onPress={() => setExpanded(open => !open)} style={{ minHeight: 40, paddingHorizontal: 10, paddingVertical: 8, gap: 3 }}>
      <Text style={{ color: error ? theme.colors.statusDanger : theme.colors.foreground, fontWeight: "600", fontSize: 12 }}>{expanded ? "▾" : "▸"} {row.name}{error ? " · Error" : row.results.length ? " · Result recorded" : " · Call recorded"}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{row.results.length ? `${text.split("\n").length} ${text.includes("\n") ? "lines" : "line"}${row.results.some(e => e.truncated) ? " · partial excerpt" : ""}` : "No result in this excerpt"}</Text>
    </Pressable>
    {expanded ? <View style={{ gap: 6, padding: 10, borderTopWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
      {!row.callRecorded ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>The tool call is not included in this excerpt.</Text> : null}
      {row.results.some(e => e.truncated) ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Partial tool result · earlier text omitted.</Text> : null}
      {text ? <ScrollView style={{ maxHeight: 240 }}><ScrollView horizontal><Text selectable style={{ fontFamily: monospace, fontSize: 12, lineHeight: 18, color: theme.colors.foreground }}>{text}</Text></ScrollView></ScrollView>
        : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Tool arguments are not included. No result is recorded in this excerpt.</Text>}
    </View> : null}
  </View>;
}

export function WorkerOutputView({ output, theme }: { output: WorkerOutput; theme: PluginTheme }) {
  const rows = output.entries ? outputRows(output.entries) : [];
  return <ScrollView style={{ maxHeight: 420 }}>
    <View style={{ gap: 10 }}>
      {!output.entries ? <><Text style={{ color: theme.colors.foregroundMuted }}>Legacy plain-text excerpt</Text><Text selectable style={{ color: theme.colors.foreground }}>{output.text || "No recorded output is available yet."}</Text></>
        : !rows.length ? <Text style={{ color: theme.colors.foregroundMuted }}>{output.truncated ? "No complete visible messages fit in this bounded excerpt." : "No recorded output is available yet."}</Text>
          : rows.map(row => row.type === "tool" ? <ToolOutput key={row.id} row={row} theme={theme} /> : <View key={row.id} style={{ gap: 4 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{row.type === "final" ? "Saved final response" : "Assistant"}{row.truncated ? " · partial excerpt" : ""}</Text>
            <AssistantOutput text={row.text} theme={theme} />
          </View>)}
    </View>
  </ScrollView>;
}
