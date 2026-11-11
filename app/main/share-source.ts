// Which screens and windows the user can share from a call window, and
// what the source picker and the share panel report.

export type SourceKind = "screen" | "window";

export type SharePanelAction =
  "change-source" | "stop-sharing" | "stop-control";

const sharePanelActions: readonly SharePanelAction[] = [
  "change-source",
  "stop-sharing",
  "stop-control",
];

export function sourceKind(id: string): SourceKind {
  return id.startsWith("screen:") ? "screen" : "window";
}

// The sources to offer, screens first, without the excluded ones, like
// the call window itself, and without windows that have no title.
export function sourcesToOffer<Source extends {id: string; name: string}>(
  sources: readonly Source[],
  excludedIds: ReadonlySet<string>,
): Source[] {
  const offered = sources.filter(
    (source) =>
      !excludedIds.has(source.id) &&
      (sourceKind(source.id) === "screen" || source.name.trim() !== ""),
  );
  return [
    ...offered.filter((source) => sourceKind(source.id) === "screen"),
    ...offered.filter((source) => sourceKind(source.id) === "window"),
  ];
}

// The source chosen in the source picker, which can only be one that it
// was offered.
export function chosenSource<Source extends {id: string}>(
  message: unknown,
  offered: readonly Source[],
): Source | undefined {
  return offered.find((source) => source.id === message);
}

// The button clicked in the share panel.
export function sharePanelAction(
  message: unknown,
): SharePanelAction | undefined {
  return sharePanelActions.find((action) => action === message);
}
