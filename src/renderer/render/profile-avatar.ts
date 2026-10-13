import type { PublicProfile } from "../../shared/types";
import { escapeHtml as e } from "../util";

export function profileAvatar(profile: PublicProfile): string {
  if (profile.avatarDataUrl && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(profile.avatarDataUrl)) return `<span class="profile-avatar"><img src="${e(profile.avatarDataUrl)}" alt="" /></span>`;
  const color = profile.source === "native" ? 0 : [...profile.id].reduce((sum,c)=>sum+c.charCodeAt(0),0)%4;
  return `<span class="profile-avatar avatar-${color}" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 22v-3a8 8 0 0 1 16 0v3" fill="currentColor"/></svg></span>`;
}
