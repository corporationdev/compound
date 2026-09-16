/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show } from "solid-js";

import { Badge } from "@/components/ui/badge";

import { DashboardCardButton, DashboardCardMeta, DashboardCardPreview, DashboardProjectThumbnail } from "./shared";
import { formatEditedAt } from "./utils";

import type { CloudProject } from "@/lib/cloud-projects";
import type { ProjectRecord } from "@/projects";

type DashboardCloudProjectCardProps = {
  project: CloudProject;
  /** The checkout of this project on this machine, when there is one. */
  local: ProjectRecord | undefined;
  active: boolean;
  /** Set while this card's project is being opened (a folder may be on its way). */
  opening: boolean;
  onSelect: () => void;
  onDeselect: () => void;
  onOpen: () => void;
};

/**
 * A project in the active organization's cloud list: name, when it last
 * changed, and whether it already has a folder here. Opening one that does
 * not brings a folder in first.
 */
export function DashboardCloudProjectCard(props: DashboardCloudProjectCardProps) {
  return (
    <DashboardCardButton
      active={props.active}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
      onEscape={props.onDeselect}
    >
      <DashboardCardPreview>
        <DashboardProjectThumbnail cover={props.local?.cover ?? null} />
        <Show when={props.local}>
          <Badge variant="base" class="absolute right-1.5 top-1.5" title={props.local?.dir}>
            On this Mac
          </Badge>
        </Show>
      </DashboardCardPreview>
      <DashboardCardMeta
        title={props.project.name}
        subtitle={props.opening ? "Opening…" : formatEditedAt(new Date(props.project.updatedAt).toISOString())}
      />
    </DashboardCardButton>
  );
}
