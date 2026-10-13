import type { BifrostSnapshot, CdpPortSuggestion } from "../shared/types";

export type ConfirmIntent =
  | {
      kind: "disable-bifrost-rule";
      ruleName: string;
      ruleCount: number;
    }
  | {
      kind: "remove-profile-bifrost-rule";
      profileId: string;
      ruleKind: "local" | "group";
      ruleRef: string;
    }
  | {
      kind: "profile";
      action: "close" | "delete" | "delete-after-chrome-exit";
      profileId: string;
    }
  | {
      kind: "close-profile-for-bifrost";
      profileId: string;
    }
  | {
      kind: "profile-sync";
      sourceProfileId: string;
      targetProfileId: string;
      syncAccount: boolean;
      syncExtensions: boolean;
      shouldCloseTarget: boolean;
      existingRecordSyncedAt: string | null;
      launchTarget: boolean;
    }
  | {
      kind: "delete-extension";
      profileId: string;
      extensionId: string;
    }
  | {
      kind: "extension-migration";
      sourceProfileId: string;
      targetProfileId: string;
      extensionIds: string[];
      selectedCount: number;
      includeData: boolean;
      openInstallPages: boolean;
      onlyChanged: boolean;
      shouldCloseTarget: boolean;
      shouldCloseSource: boolean;
    }
  | {
      kind: "clone-profiles";
      sourceProfileId: string;
      count: number;
      namePrefix: string;
      includeExtensions: boolean;
      launchAfter: boolean;
    }
  | {
      kind: "refresh-clones";
      sourceProfileId: string;
    }
  | {
      kind: "reset-clone";
      profileId: string;
    }
  | {
      kind: "disconnect-client";
      profileId: string;
      pid: number;
    }
  | {
      kind: "agent-takeover";
      profileId: string;
    }
  | {
      // Bifrost 启动失败后的直连逃生口确认：cdpPort 为 null 表示普通启动，数字表示以 CDP 模式沿用该端口重试。
      kind: "bifrost-bypass-launch";
      profileId: string;
      cdpPort: number | null;
      errorMessage: string;
    };

export type BusyState = {
  key: string;
  message: string;
  profileId?: string;
  extensionId?: string;
  steps?: BusyProgressStep[];
  stepIndex?: number;
  stepCount?: number;
  cancelRequested?: boolean;
  paused?: boolean;
};

export type BusyProgressStep = {
  label: string;
  status: "pending" | "active" | "done";
};

export type ModalState =
  | { kind: "new" }
  | { kind: "rename"; profileId: string }
  | { kind: "cdp"; profileId: string; portSuggestion: CdpPortSuggestion | null }
  | { kind: "bifrost-proxy"; profileId: string; snapshot: BifrostSnapshot | null }
  | { kind: "extension-migration" }
  | { kind: "clone-pool" }
  | { kind: "clone-tag"; profileId: string }
  | { kind: "global-instructions" }
  | { kind: "control-preferences"; activeTab: import("../shared/control-preferences").ControlPreferencesDomain; editors: Record<import("../shared/control-preferences").ControlPreferencesDomain, import("../shared/control-preferences").ControlPreferencesEditor>; discard: false | "close" | "reload" }
  | { kind: "onboarding" }
  | { kind: "profile-details"; profileId: string }
  | { kind: "external-details"; userDataDir: string }
  | { kind: "live-zoom"; profileId: string; returnTo?: "profile-details" }
  | {
      kind: "confirm";
      intent: ConfirmIntent;
      returnTo?: "extension-migration" | "clone-pool";
    }
  | null;

export type ToastKind = "normal" | "error";

export type ConfirmModalTone = "primary" | "warn" | "danger";

export type ConfirmBodyLine = string | { text: string; tone: "danger" };

export interface ConfirmModalView {
  kicker: string;
  title: string;
  body: ConfirmBodyLine[];
  confirmLabel: string;
  tone: ConfirmModalTone;
  summary: Array<{ label: string; value: string }>;
}
