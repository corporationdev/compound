/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The chat panel, and the few things the rest of the app touches: the
// right sidebar and its tabs, the sidebar width, the model picker the home
// view shares, the home-view handoff, and the attachment helpers.

export { RightSidebar } from "./right-sidebar";
export { SidebarTabs } from "./sidebar-tabs";
export { ModelPicker, harnessIcon } from "./model-picker";
export {
  rightSidebarWidth,
  sidebarTab,
  setSidebarTab,
  startChat,
  currentModel,
  storedModel,
  setStoredModel,
  ensureConnected,
  EDITOR_SIDEBAR_WIDTH,
  CHAT_SIDEBAR_WIDTH,
  type HarnessId,
  type ModelRef,
} from "./store";
export {
  AttachmentTile,
  DropOverlay,
  attachmentPaths,
  createDropZone,
  droppedAttachments,
  mergeAttachments,
  type Attachment,
} from "./attachments";
