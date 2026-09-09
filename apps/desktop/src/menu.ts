/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, dialog, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

import { CLI_LINK_PATH, installCli } from "./cli-install";

async function installCliFromMenu() {
  const result = await installCli();
  if (result.status === "cancelled") return;
  if (result.status === "installed") {
    await dialog.showMessageBox({
      type: "info",
      message: "The compound command line tool was installed.",
      detail: `Linked at ${CLI_LINK_PATH}. Run "compound --help" in a terminal to get started.`,
    });
  } else {
    await dialog.showMessageBox({
      type: "error",
      message: "Could not install the compound command line tool.",
      detail: result.error,
    });
  }
}

export function setupAppMenu() {
  if (process.platform !== "darwin") return;

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Install compound Command Line Tool…",
          enabled: app.isPackaged,
          click: installCliFromMenu,
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
