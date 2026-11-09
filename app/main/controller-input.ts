import {z} from "zod";

import type {RemoteControl} from "./remote-control.ts";
import type {RemoteInput} from "./remote-input.ts";

const positionSchema = {
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
};

// Version 1 of the mouse messages sent by the Zulip call page.
const messageSchema = z.object({
  version: z.literal(1),
  type: z.literal("mouse"),
  token: z.string().length(32),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  event: z.discriminatedUnion("type", [
    z.object({type: z.literal("move"), ...positionSchema}),
    z.object({
      type: z.literal("button"),
      ...positionSchema,
      button: z.enum(["left", "middle", "right"]),
      down: z.boolean(),
    }),
    z.object({
      type: z.literal("wheel"),
      ...positionSchema,
      dx: z.number().int().min(-12_000).max(12_000),
      dy: z.number().int().min(-12_000).max(12_000),
    }),
  ]),
});
type Message = z.infer<typeof messageSchema>;

export type ScreenBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function screenPoint(
  position: {x: number; y: number},
  bounds: ScreenBounds,
): {x: number; y: number} | undefined {
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    position.x < 0 ||
    position.x > 1 ||
    position.y < 0 ||
    position.y > 1 ||
    Object.values(bounds).some((value) => !Number.isSafeInteger(value)) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return undefined;
  }

  return {
    x: bounds.x + Math.round(position.x * (bounds.width - 1)),
    y: bounds.y + Math.round(position.y * (bounds.height - 1)),
  };
}

// Input is checked again here, across the renderer/main trust boundary.
export class ControllerInput {
  private readonly control: RemoteControl;
  private readonly input: RemoteInput;
  private readonly getBounds: () => ScreenBounds | undefined;
  private token: string | undefined;
  private lastPositionSequence = 0;
  private lastReliableSequence = 0;
  private allowance = 120;
  private lastEventTime = 0;

  constructor(
    control: RemoteControl,
    input: RemoteInput,
    getBounds: () => ScreenBounds | undefined,
  ) {
    this.control = control;
    this.input = input;
    this.getBounds = getBounds;
  }

  // Whether a message is new, and within the input rate limit.
  private admit(message: Message, now: number): boolean {
    if (this.token !== message.token) {
      this.token = message.token;
      this.lastPositionSequence = 0;
      this.lastReliableSequence = 0;
      this.allowance = 120;
      this.lastEventTime = now;
    }

    if (
      message.sequence <=
      (message.event.type === "move"
        ? this.lastPositionSequence
        : this.lastReliableSequence)
    ) {
      return false;
    }

    // A burst is allowed, but sustained input is limited to 120 events/s.
    this.allowance = Math.min(
      120,
      this.allowance + Math.max(0, now - this.lastEventTime) * 0.12,
    );
    this.lastEventTime = now;
    if (this.allowance < 1) {
      // Dropping a button-up could leave a drag active on the owner's PC.
      this.control.stop();
      return false;
    }

    this.allowance -= 1;
    return true;
  }

  private injected(accepted: boolean): void {
    if (accepted) {
      this.control.inputReceived();
    } else {
      this.control.stop();
    }
  }

  receive(identity: unknown, data: unknown, now = performance.now()): void {
    const {state} = this.control;
    if (
      state.state !== "controlled" ||
      identity !== state.participant.identity
    ) {
      return;
    }

    const result = messageSchema.safeParse(data);
    if (!result.success || result.data.token !== state.token) {
      return;
    }

    const message = result.data;
    if (!this.admit(message, now)) {
      return;
    }

    const {sequence, event} = message;
    const bounds = this.getBounds();
    const point = bounds === undefined ? undefined : screenPoint(event, bounds);
    if (point === undefined) {
      this.control.stop();
      return;
    }

    this.lastPositionSequence = Math.max(this.lastPositionSequence, sequence);
    if (event.type !== "move") {
      this.lastReliableSequence = sequence;
    }

    // Reliable actions carry their own position: a lost move must not
    // turn a click into a click on whatever happens to be under the cursor.
    // Repeating the position also gives newly activated windows a move
    // before a wheel event.
    if (!this.input.moveMouse(point.x, point.y)) {
      this.control.stop();
      return;
    }

    if (event.type === "button") {
      this.injected(this.input.setMouseButton(event.button, event.down));
    } else if (event.type === "wheel") {
      this.injected(this.input.scrollWheel(event.dx, -event.dy));
    } else {
      this.injected(true);
    }
  }
}
