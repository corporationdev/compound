/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Router, HashRouter, Route } from '@solidjs/router';
import { ColorModeProvider } from '@kobalte/core';
import { Show, createEffect, type JSX } from 'solid-js';
import { Toaster } from "@/components/ui/sonner";
import { AppContextMenu } from "@/components/app-context-menu";

import { AuthProvider, useAuth } from '@/context/auth';
import { SocialProvider } from '@/context/social';
import { PersistRoute } from '@/lib/persist-route';
import { DeepLinks } from '@/lib/deep-link';
import { EditorApi } from '@/context/dapi';
import { ScreenTooSmall } from '@/components/screen-too-small';
import { UnsupportedBrowser } from '@/components/unsupported-browser';
import { ProjectPage } from '@/pages/project';
import { LoginPage } from '@/pages/login';
import { OnboardingPage, onboardingCompleted } from '@/pages/onboarding';
import { NotFoundPage } from '@/pages/not-found';
import { DashboardPage } from '@/pages/dashboard';

function AuthGate(props: { children: JSX.Element }) {
  const auth = useAuth();

  return (
    <Show when={!auth.isLoading()}>
      <Show when={auth.isAuthenticated() || auth.headless()}>
        <Show
          when={onboardingCompleted() || auth.headless()}
          fallback={<OnboardingPage />}
        >
          {props.children}
        </Show>
      </Show>
      <Show when={!auth.isAuthenticated() && !auth.headless()}>
        <LoginPage />
      </Show>
    </Show>
  );
}

function BootSplash() {
  const auth = useAuth();

  createEffect(() => {
    if (auth.isLoading()) return;
    document.getElementById('boot-splash')?.remove();
  });

  return null;
}

function EnvironmentOverlays() { return <><ScreenTooSmall /><UnsupportedBrowser /></>; }

function App() {
  const RouterComponent = window.desktop ? HashRouter : Router;
  return (
    <RouterComponent
      root={(props) => (
        <ColorModeProvider initialColorMode="dark">
          <AppContextMenu>
            <AuthProvider>
              <SocialProvider>
                {props.children}
                <BootSplash />
                <EditorApi />
              </SocialProvider>
            </AuthProvider>
          </AppContextMenu>
          <Toaster />
          <EnvironmentOverlays />
          <PersistRoute />
          <DeepLinks />
        </ColorModeProvider>
      )}
    >
      <Route path="/" component={() => <AuthGate><DashboardPage /></AuthGate>} />
      <Route path="/projects/*ref" component={() => <AuthGate><ProjectPage /></AuthGate>} />
      <Route path="*404" component={NotFoundPage} />
    </RouterComponent>
  );
}

export default App;
