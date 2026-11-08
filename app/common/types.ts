import {z} from "zod";

// https://github.com/colinhacks/zod/discussions/5983
export const exactPartial = <Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  z.util.partial(z.ZodExactOptional, schema, undefined) as z.ZodObject<{
    -readonly [K in keyof Shape]: z.ZodExactOptional<Shape[K]>;
  }>;

export type CallParticipant = {identity: string; name: string};

// What a call page learns about the remote control of its screen
// share.  The token goes to the controller, whose input must carry it.
export type RemoteControlState =
  | {state: "none"}
  | {state: "shared"}
  | {state: "requested"; participant: CallParticipant}
  | {state: "controlled"; participant: CallParticipant; token: string};

export type MenuProperties = {
  tabs: TabData[];
  activeTabIndex?: number;
  enableMenu?: boolean;
};

export type NavigationItem =
  "General" | "Network" | "AddServer" | "Organizations" | "Shortcuts";

export type ServerConfig = {
  url: string;
  alias: string;
  icon: string;
  zulipVersion: string;
  zulipFeatureLevel: number;
};

export type TabRole = "server" | "function";
export type TabPage = "Settings" | "About";

export type TabData = {
  role: TabRole;
  page?: TabPage | undefined;
  label: string;
  index: number;
};
