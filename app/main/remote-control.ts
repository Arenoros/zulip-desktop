import type {CallParticipant, RemoteControlState} from "../common/types.ts";

export type RemoteControlHooks = {
  // Asks the owner of the screen whether participant may control it,
  // until signal aborts.
  askConsent(
    participant: CallParticipant,
    signal: AbortSignal,
  ): Promise<boolean>;
  controlStarted(controller: CallParticipant): void;
  controlEnded(): void;
  stateChanged(state: RemoteControlState): void;
  newToken(): string;
};

// Whether a participant of a call may control the screen shared from
// its call window.  Only the owner's click in the consent dialog grants
// control; everything the call page reports can only end it.
export class RemoteControl {
  private readonly hooks: RemoteControlHooks;
  private readonly inactivityTimeout: number;
  private current: RemoteControlState = {state: "none"};
  private pendingConsent: AbortController | undefined;
  private inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(hooks: RemoteControlHooks, inactivityTimeout = 10 * 60 * 1000) {
    this.hooks = hooks;
    this.inactivityTimeout = inactivityTimeout;
  }

  // Ends any request or control, moving to the next state.
  private end(next: RemoteControlState): void {
    this.pendingConsent?.abort();
    this.pendingConsent = undefined;
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = undefined;
    const wasControlled = this.current.state === "controlled";
    this.setState(next);
    if (wasControlled) {
      this.hooks.controlEnded();
    }
  }

  private setState(state: RemoteControlState): void {
    this.current = state;
    this.hooks.stateChanged(state);
  }

  get state(): RemoteControlState {
    return this.current;
  }

  shareStarted(): void {
    this.end({state: "shared"});
  }

  shareStopped(): void {
    this.end({state: "none"});
  }

  async request(participant: CallParticipant): Promise<void> {
    if (this.current.state !== "shared") {
      return;
    }

    const consent = new AbortController();
    this.pendingConsent = consent;
    this.setState({state: "requested", participant});
    let allowed = false;
    try {
      allowed = await this.hooks.askConsent(participant, consent.signal);
    } catch (error: unknown) {
      console.error("Failed to ask for consent to remote control:", error);
    }

    // The request is moot if the share stopped or the participant left.
    if (this.pendingConsent !== consent) {
      return;
    }

    this.pendingConsent = undefined;
    if (!allowed) {
      this.setState({state: "shared"});
      return;
    }

    this.setState({
      state: "controlled",
      participant,
      token: this.hooks.newToken(),
    });
    this.hooks.controlStarted(participant);
    this.inputReceived();
  }

  inputReceived(): void {
    if (this.current.state !== "controlled") {
      return;
    }

    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      this.stop();
    }, this.inactivityTimeout);
  }

  // Ends control, at the request of the owner or the controller.
  stop(): void {
    if (this.current.state === "controlled") {
      this.end({state: "shared"});
    }
  }

  participantLeft(identity: string): void {
    if (
      (this.current.state === "requested" ||
        this.current.state === "controlled") &&
      this.current.participant.identity === identity
    ) {
      this.end({state: "shared"});
    }
  }
}
