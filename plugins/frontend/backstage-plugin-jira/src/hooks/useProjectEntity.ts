/*
 * Copyright 2021 Larder Software Limited
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

import { Entity } from '@backstage/catalog-model';
import {
  JIRA_BEARER_TOKEN_ANNOTATION,
  JIRA_COMPONENT_ANNOTATION,
  JIRA_LABEL_ANNOTATION,
  JIRA_PROJECT_KEY_ANNOTATION,
} from '../constants';

export const useProjectEntity = (entity: Entity) => {
  return {
    projectKey: entity.metadata?.annotations?.[
      JIRA_PROJECT_KEY_ANNOTATION
    ] as string,
    component: entity.metadata?.annotations?.[
      JIRA_COMPONENT_ANNOTATION
    ] as string,
    tokenType: entity.metadata?.annotations?.[
      JIRA_BEARER_TOKEN_ANNOTATION
    ] as string,
    label: entity.metadata?.annotations?.[JIRA_LABEL_ANNOTATION] as string,
  };
};
