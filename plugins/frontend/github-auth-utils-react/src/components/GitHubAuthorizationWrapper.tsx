/*
 * Copyright 2025 Larder Software Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import { InfoCard } from '@backstage/core-components';
import { useGithubLoggedIn } from '../hooks/useGithubLoggedIn';
import { GithubNotAuthorized } from './GitHubNotAuthorized';

export const GitHubAuthorizationWrapper = ({
  children,
  title,
  hostname,
}: {
  children: React.ReactNode;
  title: string;
  hostname?: string;
}) => {
  const { isLoggedIn, addLoginStatus } = useGithubLoggedIn();
  return isLoggedIn ? (
    children
  ) : (
    <InfoCard title={title}>
      <GithubNotAuthorized
        addLoginStatus={addLoginStatus}
        hostname={hostname}
      />
    </InfoCard>
  );
};
