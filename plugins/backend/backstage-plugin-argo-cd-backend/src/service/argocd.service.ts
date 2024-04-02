import { Config } from '@backstage/config';
import fetch from 'cross-fetch';
import { Logger } from 'winston';
import { timer } from './timer.services';

import {
  ArgoServiceApi,
  CreateArgoApplicationProps,
  CreateArgoProjectProps,
  CreateArgoResourcesProps,
  DeleteApplicationProps,
  DeleteProjectProps,
  InstanceConfig,
  ResyncProps,
  SyncArgoApplicationProps,
  SyncResponse,
  findArgoAppResp,
  DeleteApplicationAndProjectProps,
  DeleteApplicationAndProjectResponse,
  ResponseSchema,
  getRevisionDataResp,
  BuildArgoProjectArgs,
  BuildArgoApplicationArgs,
  UpdateArgoProjectAndAppProps,
  UpdateArgoApplicationProps,
  UpdateArgoProjectProps,
  GetArgoProjectProps,
  GetArgoProjectResp,
  ArgoProject,
  ResourceItem,
  GetArgoApplicationResp,
  TerminateArgoAppOperationResp,
  DeleteArgoAppResp,
  DeleteArgoProjectResp,
} from './types';
import { getArgoConfigByInstanceName } from '../utils/getArgoConfig';

const APP_NAMESPACE_QUERY_PARAM = 'appNamespace';

export class ArgoService implements ArgoServiceApi {
  instanceConfigs: InstanceConfig[];

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.instanceConfigs = this.config
      .getConfigArray('argocd.appLocatorMethods')
      .filter(element => element.getString('type') === 'config')
      .reduce(
        (acc: Config[], argoApp: Config) =>
          acc.concat(argoApp.getConfigArray('instances')),
        [],
      )
      .map(instance => ({
        name: instance.getString('name'),
        url: instance.getString('url'),
        token: instance.getOptionalString('token'),
        username: instance.getOptionalString('username'),
        password: instance.getOptionalString('password'),
      }));
  }

  getArgoInstanceArray(): InstanceConfig[] {
    return this.getAppArray().map(instance => ({
      name: instance.getString('name'),
      url: instance.getString('url'),
      token: instance.getOptionalString('token'),
      username: instance.getOptionalString('username'),
      password: instance.getOptionalString('password'),
    }));
  }

  getAppArray(): Config[] {
    const argoApps = this.config
      .getConfigArray('argocd.appLocatorMethods')
      .filter(element => element.getString('type') === 'config');

    return argoApps.reduce(
      (acc: Config[], argoApp: Config) =>
        acc.concat(argoApp.getConfigArray('instances')),
      [],
    );
  }

  async getRevisionData(
    baseUrl: string,
    options: {
      name: string;
      namespace?: string;
    },
    argoToken: string,
    revisionID: string,
  ): Promise<getRevisionDataResp> {
    const requestOptions: RequestInit = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
    };

    let url = `${baseUrl}/api/v1/applications/${options.name}/revisions/${revisionID}/metadata`;
    if (options.namespace) {
      url = `${url}?${APP_NAMESPACE_QUERY_PARAM}=${options.namespace}`;
    }

    const resp = await fetch(url, requestOptions);

    if (!resp.ok) {
      throw new Error(`Request failed with ${resp.status} Error`);
    }

    const data: getRevisionDataResp = await resp?.json();
    return data;
  }

  async findArgoApp(options: {
    name?: string;
    selector?: string;
    namespace?: string;
  }): Promise<findArgoAppResp[]> {
    if (!options.name && !options.selector) {
      throw new Error('name or selector is required');
    }
    const resp = await Promise.all(
      this.instanceConfigs.map(async (argoInstance: any) => {
        let getArgoAppDataResp: any;
        let token: string;
        try {
          token = argoInstance.token || (await this.getArgoToken(argoInstance));
        } catch (error: any) {
          this.logger.error(
            `Error getting token from Argo Instance ${argoInstance.name}: ${error.message}`,
          );
          return null;
        }

        try {
          getArgoAppDataResp = await this.getArgoAppData(
            argoInstance.url,
            argoInstance.name,
            token,
            options,
          );
        } catch (error: any) {
          this.logger.error(
            `Error getting Argo App Data from Argo Instance ${argoInstance.name}: ${error.message}`,
          );
          return null;
        }

        if (options.selector && !getArgoAppDataResp.items) {
          return null;
        }

        return {
          name: argoInstance.name as string,
          url: argoInstance.url as string,
          appName: options.selector
            ? getArgoAppDataResp.items.map((x: any) => x.metadata.name)
            : [options.name],
        };
      }),
    ).catch();
    return resp.flatMap(f => (f ? [f] : []));
  }

  async getArgoProject({
    baseUrl,
    argoToken,
    projectName,
  }: GetArgoProjectProps): Promise<GetArgoProjectResp> {
    const requestOptions: RequestInit = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
    };

    const resp = await fetch(
      `${baseUrl}/api/v1/projects/${projectName}`,
      requestOptions,
    );
    const data = await resp.json();

    if (resp.status !== 200) {
      this.logger.error(
        `Failed to get argo project ${projectName}: ${data.message}`,
      );
      throw new Error(`Failed to get argo project: ${data.message}`);
    }

    return data;
  }

  async getArgoToken(appConfig: {
    url: string;
    username?: string;
    password?: string;
  }): Promise<string> {
    const { url, username, password } = appConfig;

    const options: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: username || this.username,
        password: password || this.password,
      }),
    };
    const resp = await fetch(`${url}/api/v1/session`, options);
    if (!resp.ok) {
      this.logger.error(`failed to get argo token: ${url}`);
    }
    if (resp.status === 401) {
      throw new Error(`Getting unauthorized for Argo CD instance ${url}`);
    }
    const data = await resp.json();
    return data.token;
  }

  async getArgoAppData(
    baseUrl: string,
    argoInstanceName: string,
    argoToken: string,
    options?: {
      name?: string;
      selector?: string;
      namespace?: string;
    },
  ): Promise<any> {
    let urlSuffix = '';

    if (options?.name) {
      urlSuffix = `/${options.name}`;
      if (options?.namespace) {
        urlSuffix = `${urlSuffix}?${APP_NAMESPACE_QUERY_PARAM}=${options.namespace}`;
      }
    }

    if (options?.selector) {
      urlSuffix = `?selector=${options.selector}`;
      // add query param for namespace if it exists
      if (options?.namespace) {
        urlSuffix = `${urlSuffix}&${APP_NAMESPACE_QUERY_PARAM}=${options.namespace}`;
      }
    }

    const requestOptions: RequestInit = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
    };

    const resp = await fetch(
      `${baseUrl}/api/v1/applications${urlSuffix}`,
      requestOptions,
    ); // TODO: dive deep here and fix this call.  add types, we can see what are the different options, there multiple applications can be returned.

    if (!resp.ok) {
      throw new Error(`Request failed with ${resp.status} Error`);
    }

    const data = await resp?.json();
    if (data.items) {
      (data.items as any[]).forEach(item => {
        item.metadata.instance = { name: argoInstanceName };
      });
    } else if (data && options?.name) {
      data.instance = argoInstanceName;
    }
    return data;
  }

  private buildArgoProjectPayload({
    projectName,
    namespace,
    destinationServer,
    resourceVersion,
    sourceRepo,
  }: BuildArgoProjectArgs): ArgoProject {
    const clusterResourceBlacklist = this.config.getOptional<ResourceItem[]>(
      `argocd.projectSettings.clusterResourceBlacklist`,
    );
    const clusterResourceWhitelist = this.config.getOptional<ResourceItem[]>(
      `argocd.projectSettings.clusterResourceWhitelist`,
    );
    const namespaceResourceBlacklist = this.config.getOptional<ResourceItem[]>(
      `argocd.projectSettings.namespaceResourceBlacklist`,
    );
    const namespaceResourceWhitelist = this.config.getOptional<ResourceItem[]>(
      `argocd.projectSettings.namespaceResourceWhitelist`,
    );

    const project: ArgoProject = {
      metadata: {
        name: projectName,
        resourceVersion,
      },
      spec: {
        destinations: [
          {
            name: 'local',
            namespace: namespace,
            server: destinationServer ?? 'https://kubernetes.default.svc',
          },
        ],
        ...(clusterResourceBlacklist && { clusterResourceBlacklist }),
        ...(clusterResourceWhitelist && { clusterResourceWhitelist }),
        ...(namespaceResourceBlacklist && { namespaceResourceBlacklist }),
        ...(namespaceResourceWhitelist && { namespaceResourceWhitelist }),
        sourceRepos: Array.isArray(sourceRepo) ? sourceRepo : [sourceRepo],
      },
    };
    return project;
  }

  async createArgoProject({
    baseUrl,
    argoToken,
    projectName,
    namespace,
    sourceRepo,
    destinationServer,
  }: CreateArgoProjectProps): Promise<object> {
    const data = {
      project: this.buildArgoProjectPayload({
        projectName,
        namespace,
        sourceRepo,
        destinationServer,
      }),
    };

    const options: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
      body: JSON.stringify(data),
    };
    const resp = await fetch(`${baseUrl}/api/v1/projects`, options);
    const responseData = await resp.json();
    if (resp.status === 403) {
      throw new Error(responseData.message);
    } else if (resp.status === 404) {
      return resp.json();
    } else if (
      JSON.stringify(responseData).includes(
        'existing project spec is different',
      )
    ) {
      throw new Error('Duplicate project detected. Cannot overwrite existing.');
    }
    return responseData;
  }

  private async updateArgoProject({
    baseUrl,
    argoToken,
    projectName,
    namespace,
    sourceRepo,
    resourceVersion,
    destinationServer,
  }: UpdateArgoProjectProps): Promise<object> {
    const data = this.buildArgoProjectPayload({
      projectName,
      namespace,
      sourceRepo,
      resourceVersion,
      destinationServer,
    });

    const options: RequestInit = {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
      body: JSON.stringify(data),
    };
    const resp = await fetch(
      `${baseUrl}/api/v1/projects/${projectName}`,
      options,
    );
    const responseData = await resp.json();
    if (resp.status !== 200) {
      this.logger.error(
        `Error updating argo project ${projectName}: ${responseData.message}`,
      );
      throw new Error(`Error updating argo project: ${responseData.message}`);
    }
    return responseData;
  }

  private buildArgoApplicationPayload({
    appName,
    projectName,
    namespace,
    sourceRepo,
    sourcePath,
    labelValue,
    resourceVersion,
    destinationServer,
  }: BuildArgoApplicationArgs) {
    return {
      metadata: {
        name: appName,
        labels: { 'backstage-name': labelValue },
        finalizers: ['resources-finalizer.argocd.argoproj.io'],
        resourceVersion,
      },
      spec: {
        destination: {
          namespace: namespace,
          server: destinationServer
            ? destinationServer
            : 'https://kubernetes.default.svc',
        },
        project: projectName,
        revisionHistoryLimit: 10,
        source: {
          path: sourcePath,
          repoURL: sourceRepo,
        },
        syncPolicy: {
          automated: {
            allowEmpty: true,
            prune: true,
            selfHeal: true,
          },
          retry: {
            backoff: {
              duration: '5s',
              factor: 2,
              maxDuration: '5m',
            },
            limit: 10,
          },
          syncOptions: ['CreateNamespace=false', 'FailOnSharedResource=true'],
        },
      },
    };
  }

  async createArgoApplication({
    baseUrl,
    argoToken,
    appName,
    projectName,
    namespace,
    sourceRepo,
    sourcePath,
    labelValue,
    destinationServer,
  }: CreateArgoApplicationProps): Promise<object> {
    const data = this.buildArgoApplicationPayload({
      appName,
      projectName,
      namespace,
      sourcePath,
      sourceRepo,
      labelValue,
      destinationServer,
    });

    const options: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
      body: JSON.stringify(data),
    };

    const resp = await fetch(`${baseUrl}/api/v1/applications`, options);
    const respData = await resp.json();
    if (!resp.ok) {
      throw new Error(`Error creating argo app: ${respData.message}`);
    }
    return respData;
  }

  async resyncAppOnAllArgos({
    appSelector,
  }: ResyncProps): Promise<SyncResponse[][]> {
    const argoAppResp: findArgoAppResp[] = await this.findArgoApp({
      selector: appSelector,
    });
    if (argoAppResp) {
      const parallelSyncCalls = argoAppResp.map(
        async (argoInstance: any): Promise<SyncResponse[]> => {
          try {
            const token = await this.getArgoToken(argoInstance);
            try {
              const resp = argoInstance.appName.map(
                (argoApp: any): Promise<SyncResponse> => {
                  return this.syncArgoApp({
                    argoInstance,
                    argoToken: token,
                    appName: argoApp,
                  });
                },
              );
              return await Promise.all(resp);
            } catch (e: any) {
              return [{ status: 'Failure', message: e.message }];
            }
          } catch (e: any) {
            return [{ status: 'Failure', message: e.message }];
          }
        },
      );

      return await Promise.all(parallelSyncCalls);
    }
    return [];
  }

  async syncArgoApp({
    argoInstance,
    argoToken,
    appName,
  }: SyncArgoApplicationProps): Promise<SyncResponse> {
    const data = {
      prune: false,
      dryRun: false,
      strategy: {
        hook: {
          force: true,
        },
      },
      resources: null,
    };

    const options: RequestInit = {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
    };
    const resp = await fetch(
      `${argoInstance.url}/api/v1/applications/${appName}/sync`,
      options,
    );
    if (resp.ok) {
      return {
        status: 'Success',
        message: `Re-synced ${appName} on ${argoInstance.name}`,
      };
    }
    return {
      message: `Failed to resync ${appName} on ${argoInstance.name}`,
      status: 'Failure',
    };
  }

  private async updateArgoApp({
    baseUrl,
    argoToken,
    appName,
    projectName,
    namespace,
    sourceRepo,
    sourcePath,
    labelValue,
    resourceVersion,
    destinationServer,
  }: UpdateArgoApplicationProps): Promise<object> {
    const data = this.buildArgoApplicationPayload({
      appName,
      projectName,
      namespace,
      sourceRepo,
      sourcePath,
      labelValue,
      resourceVersion,
      destinationServer,
    });

    const options: RequestInit = {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${argoToken}`,
      },
      body: JSON.stringify(data),
    };

    const resp = await fetch(
      `${baseUrl}/api/v1/applications/${appName}`,
      options,
    );
    const respData = await resp.json();
    if (resp.status !== 200) {
      this.logger.error(
        `Error updating argo app ${appName}: ${respData.message}`,
      );
      throw new Error(`Error updating argo app: ${respData.message}`);
    }

    return respData;
  }

  // @see https://cd.apps.argoproj.io/swagger-ui#operation/ApplicationService_Delete
  async deleteApp({
    baseUrl,
    argoApplicationName,
    argoToken,
    terminateOperation,
  }: DeleteApplicationProps) {
    const options: RequestInit = {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${argoToken}`,
        'Content-Type': 'application/json',
      },
    };

    // I know that the terminate operation is a proxy, but we should probably handle the responses?
    // If the terminate operation fails to terminate anything, then should that be forwarded to the user or not? 404, 401, 403.
    if (terminateOperation)
      await this.terminateArgoAppOperation({
        argoAppName: argoApplicationName,
        baseUrl: baseUrl,
        argoToken: argoToken,
      });

    let statusText: string = '';
    try {
      const response = (await fetch(
        `${baseUrl}/api/v1/applications/${argoApplicationName}?${new URLSearchParams(
          {
            cascade: 'true',
          },
        )}`,
        options,
      )) as DeleteArgoAppResp;
      statusText = response.statusText;
      return { ...(await response.json()), statusCode: response.status };
    } catch (error) {
      this.logger.error(
        `Error Deleting Argo Application for application ${argoApplicationName} in ${baseUrl} - ${JSON.stringify(
          { statusText, error: (error as Error).message },
        )}`,
      );
      throw error;
    }
  }

  // @see https://cd.apps.argoproj.io/swagger-ui#operation/ProjectService_Delete
  async deleteProject({
    baseUrl,
    argoProjectName,
    argoToken,
  }: DeleteProjectProps) {
    const options: RequestInit = {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${argoToken}`,
        'Content-Type': 'application/json',
      },
    };

    let statusText: string = '';
    try {
      const response = (await fetch(
        `${baseUrl}/api/v1/projects/${argoProjectName}`,
        options,
      )) as DeleteArgoProjectResp;

      statusText = response.statusText;
      return { ...(await response.json()), statusCode: response.status };
    } catch (error) {
      this.logger.error(
        `Error Deleting Argo Project for project  ${argoProjectName} in ${baseUrl} - ${JSON.stringify(
          { statusText, error: (error as Error).message },
        )}`,
      );
      throw error;
    }
  }

  async deleteAppandProject({
    argoAppName,
    argoInstanceName,
    terminateOperation,
  }: DeleteApplicationAndProjectProps): Promise<DeleteApplicationAndProjectResponse> {
    let continueToDeleteProject: boolean = false;
    // const terminateAppResponse: ResponseSchema = {
    //   status: '',
    //   message: '',
    // }
    const response: DeleteApplicationAndProjectResponse = {
      
    }
    const argoDeleteAppResp: ResponseSchema = {
      status: '',
      message: '',
      argoResponse: '',
    };
    const argoDeleteProjectResp: ResponseSchema = {
      status: '',
      message: '',
      argoResponse: '',
    };

    const matchedArgoInstance = this.instanceConfigs.find(
      argoInstance => argoInstance.name === argoInstanceName,
    );
    if (matchedArgoInstance === undefined) {
      throw new Error('cannot find an argo instance to match this cluster');
    }

    let token: string;
    if (!matchedArgoInstance.token) {
      token = await this.getArgoToken(matchedArgoInstance);
    } else {
      token = matchedArgoInstance.token;
    }

    const deleteAppResp = await this.deleteApp({
      baseUrl: matchedArgoInstance.url,
      argoApplicationName: argoAppName,
      argoToken: token,
      terminateOperation,
    });

    if (
      deleteAppResp.statusCode !== (404 || 200) &&
      'message' in deleteAppResp
    ) {
      argoDeleteAppResp.status = 'failed';
      argoDeleteAppResp.message = deleteAppResp.message;
    } else if (deleteAppResp.statusCode === 404 && 'message' in deleteAppResp) {
      continueToDeleteProject = true;
      argoDeleteAppResp.status = 'success'; // success or failure?
      argoDeleteAppResp.message = 'application does not exist and therefore does not need to be deleted'; // do we want message included here
      // argoDeleteAppResp.argoMessage = deleteAppResp.message
      // application not found
    } else if (deleteAppResp.statusCode === 200) {
      argoDeleteAppResp.status = 'success';
      argoDeleteAppResp.message = 'application pending deletion';

      this.logger.info('attempting to wait for argo application to delete');
      const configuredWaitForApplicationToDeleteCycles =
        this.config.getOptionalNumber('argocd.waitCycles') || 1;
      // introduce wait interval time configuration in the app config
      for (
        let attempts = 0;
        attempts < configuredWaitForApplicationToDeleteCycles;
        attempts++
      ) {
        const applicationInfo = await this.getArgoApplicationInfo({
          baseUrl: matchedArgoInstance.url,
          argoApplicationName: argoAppName,
          argoToken: token,
        });
        if (
          applicationInfo.statusCode !== (404 || 200) &&
          'message' in applicationInfo
        ) {
          argoDeleteAppResp.status = 'failed';
          argoDeleteAppResp.message = `a request was successfully sent to delete your application, but when getting your application information we received ${applicationInfo.message}`;
          break;
          // Test 'deletes and project even when getArgoCD error returns error for one iteration but deletes later' suggests we do not want to break here
        } else if (
          applicationInfo.statusCode === 404 &&
          'message' in applicationInfo
        ) {
          continueToDeleteProject = true;
          argoDeleteAppResp.status = 'success';
          argoDeleteAppResp.message = `application deleted successfully - ${applicationInfo.message}`; // do we want message included here
          break;
        } else if (
          applicationInfo.statusCode === 200 &&
          'metadata' in applicationInfo
        ) {
          argoDeleteAppResp.status = 'success'; // Do we want this to be considered a success or failed? // pending
          argoDeleteAppResp.message = `application still pending deletion with the deletion timestamp of ${applicationInfo.metadata.deletionTimestamp} and deletionGracePeriodSeconds of ${applicationInfo.metadata.deletionGracePeriodSeconds}`;
          if (attempts < configuredWaitForApplicationToDeleteCycles - 1)
            await timer(5000);
        }
      }
    }

    if (continueToDeleteProject) {
      const deleteProjectResponse = await this.deleteProject({
        baseUrl: matchedArgoInstance.url,
        argoProjectName: argoAppName,
        argoToken: token,
      });
      if (
        deleteProjectResponse.statusCode !== (404 || 200) &&
        'message' in deleteProjectResponse
      ) {
        argoDeleteProjectResp.status = 'failed';
        argoDeleteProjectResp.message = `project deletion failed - ${deleteProjectResponse.message}`;
      } else if (
        deleteProjectResponse.statusCode === 404 &&
        'message' in deleteProjectResponse
      ) {
        argoDeleteProjectResp.status = 'success';
        argoDeleteProjectResp.message = `project does not exist and therefore does not need to be deleted - ${deleteProjectResponse.message}`;
      } else if (deleteProjectResponse.statusCode === 200) {
        argoDeleteProjectResp.status = 'success'; // pending
        argoDeleteProjectResp.message = 'project is pending deletion';
      }
    } else {
      argoDeleteProjectResp.status = 'failed';
      argoDeleteProjectResp.message =
        'project deletion skipped due to application still existing and pending deletion, or the application failed to delete';
    }

    return {
      argoDeleteAppResp: argoDeleteAppResp,
      argoDeleteProjectResp: argoDeleteProjectResp,
    };
  }

  async createArgoResources({
    argoInstance,
    appName,
    projectName,
    namespace,
    sourceRepo,
    sourcePath,
    labelValue,
    logger,
  }: CreateArgoResourcesProps): Promise<boolean> {
    logger.info(`Getting app ${appName} on ${argoInstance}`);
    const matchedArgoInstance = this.instanceConfigs.find(
      argoHost => argoHost.name === argoInstance,
    );

    if (!matchedArgoInstance) {
      throw new Error(`Unable to find Argo instance named "${argoInstance}"`);
    }

    const token =
      matchedArgoInstance.token ||
      (await this.getArgoToken(matchedArgoInstance));

    await this.createArgoProject({
      baseUrl: matchedArgoInstance.url,
      argoToken: token,
      projectName: projectName ? projectName : appName,
      namespace,
      sourceRepo,
    });

    await this.createArgoApplication({
      baseUrl: matchedArgoInstance.url,
      argoToken: token,
      appName,
      projectName: projectName ? projectName : appName,
      namespace,
      sourceRepo,
      sourcePath,
      labelValue: labelValue ? labelValue : appName,
    });

    return true;
  }

  async updateArgoProjectAndApp({
    instanceConfig,
    argoToken,
    appName,
    projectName,
    namespace,
    sourceRepo,
    sourcePath,
    labelValue,
    destinationServer,
  }: UpdateArgoProjectAndAppProps): Promise<boolean> {
    const appData = await this.getArgoAppData(
      instanceConfig.url,
      instanceConfig.name,
      argoToken,
      { name: appName },
    );
    if (!appData.spec?.source?.repoURL) {
      this.logger.error(`No repo URL found for argo app ${projectName}`);
      throw new Error('No repo URL found for argo app');
    }
    if (!appData.metadata?.resourceVersion) {
      this.logger.error(`No resourceVersion found for argo app ${projectName}`);
      throw new Error('No resourceVersion found for argo app');
    }
    const projData = await this.getArgoProject({
      baseUrl: instanceConfig.url,
      argoToken,
      projectName,
    });
    if (!projData.metadata?.resourceVersion) {
      this.logger.error(
        `No resourceVersion found for argo project ${projectName}`,
      );
      throw new Error('No resourceVersion found for argo project');
    }
    if (appData.spec?.source?.repoURL === sourceRepo) {
      await this.updateArgoProject({
        argoToken,
        baseUrl: instanceConfig.url,
        namespace,
        projectName,
        sourceRepo,
        resourceVersion: projData.metadata.resourceVersion,
        destinationServer,
      });
      await this.updateArgoApp({
        appName,
        argoToken,
        baseUrl: instanceConfig.url,
        labelValue,
        namespace,
        projectName,
        sourcePath,
        sourceRepo,
        resourceVersion: appData.metadata.resourceVersion,
        destinationServer,
      });
      return true;
    }
    await this.updateArgoProject({
      argoToken,
      baseUrl: instanceConfig.url,
      namespace,
      projectName,
      sourceRepo: [sourceRepo, appData.spec.source.repoURL],
      resourceVersion: projData.metadata.resourceVersion,
      destinationServer,
    });
    await this.updateArgoApp({
      appName,
      argoToken,
      baseUrl: instanceConfig.url,
      labelValue,
      namespace,
      projectName,
      sourcePath,
      sourceRepo,
      resourceVersion: appData.metadata.resourceVersion,
      destinationServer,
    });
    const updatedProjData = await this.getArgoProject({
      baseUrl: instanceConfig.url,
      argoToken,
      projectName,
    });
    await this.updateArgoProject({
      argoToken,
      baseUrl: instanceConfig.url,
      namespace,
      projectName,
      sourceRepo,
      resourceVersion: updatedProjData.metadata.resourceVersion,
      destinationServer,
    });

    return true;
  }

  // @see https://cd.apps.argoproj.io/swagger-ui#operation/ApplicationService_List
  async getArgoApplicationInfo({
    argoApplicationName,
    argoInstanceName,
    baseUrl,
    argoToken,
  }: {
    argoApplicationName: string;
    argoInstanceName?: string;
    baseUrl?: string;
    argoToken?: string;
  }) {
    let url = baseUrl;
    let token = argoToken;
    if (!(baseUrl && argoToken)) {
      if (!argoInstanceName)
        throw new Error(
          `argo instance must be defined when baseurl or token are not given.`,
        );
      const matchedArgoInstance = getArgoConfigByInstanceName({
        argoConfigs: this.instanceConfigs,
        argoInstanceName,
      });
      if (!matchedArgoInstance)
        throw new Error(
          `config does not have argo information for the cluster named "${argoInstanceName}"`,
        );
      token =
        matchedArgoInstance.token ??
        (await this.getArgoToken(matchedArgoInstance));
      url = matchedArgoInstance.url;
    }

    const options = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      method: 'GET',
    };

    let statusText: string = '';
    try {
      const response = (await fetch(
        `${url}/api/v1/applications/${argoApplicationName}`,
        options,
      )) as GetArgoApplicationResp;
      statusText = response.statusText;
      return { ...(await response.json()), statusCode: response.status };
    } catch (error) {
      this.logger.error(
        `Error Getting Argo Application Information For Argo Instance Name ${
          argoInstanceName || url
        } - searching for application ${argoApplicationName} - ${JSON.stringify(
          { statusText, error: (error as Error).message },
        )}`,
      );
      throw error; // Throwing error here stops, do we want to return error instead? or include catch in call? For now changed test to not throw error but return 500 instead
    }
  }

  // @see https://cd.apps.argoproj.io/swagger-ui#operation/ApplicationService_TerminateOperation
  async terminateArgoAppOperation({
    argoAppName,
    argoInstanceName,
    baseUrl,
    argoToken,
  }: {
    argoAppName: string;
    argoInstanceName?: string;
    baseUrl?: string;
    argoToken?: string;
  }) {
    let url = baseUrl;
    let token = argoToken;
    if (!(baseUrl && argoToken)) {
      if (!argoInstanceName)
        throw new Error(
          `argo instance must be defined when baseurl or token are not given.`,
        );
      const matchedArgoInstance = getArgoConfigByInstanceName({
        argoConfigs: this.instanceConfigs,
        argoInstanceName,
      });
      if (!matchedArgoInstance)
        throw new Error(
          `config does not have argo information for the cluster named "${argoInstanceName}"`,
        );
      token =
        matchedArgoInstance.token ??
        (await this.getArgoToken(matchedArgoInstance));
      url = matchedArgoInstance.url;
    }
    const options = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      method: 'DELETE',
    };
    this.logger.info(
      `Terminating current operation for ${
        argoInstanceName ?? url
      } and ${argoAppName}`,
    );
    let statusText: string = '';
    try {
      const response = (await fetch(
        `${url}/api/v1/applications/${argoAppName}/operation`,
        options,
      )) as TerminateArgoAppOperationResp;
      statusText = response.statusText;
      return { ...(await response.json()), statusCode: response.status };
    } catch (error) {
      this.logger.error(
        `Error Terminating Argo Application Operation for application ${argoAppName} in Argo Instance Name ${argoInstanceName} - ${JSON.stringify(
          { statusText, error: (error as Error).message },
        )}`,
      );
      throw error;
    }
  }
}
