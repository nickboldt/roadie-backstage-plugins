import { errorHandler } from '@backstage/backend-common';
import { Config } from '@backstage/config';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import { ArgoService } from './argocd.service';
import { timer } from './timer.services';

export interface RouterOptions {
  logger: Logger;
  config: Config;
}
export type Response = {
  status: string
  message: string
}
export function createRouter({
  logger,
  config,
}: RouterOptions): Promise<express.Router> {
  const router = Router();
  router.use(express.json());
  const argoUserName =
    config.getOptionalString('argocd.username') ?? 'argocdUsername';
  const argoPassword =
    config.getOptionalString('argocd.password') ?? 'argocdPassword';
  const argoWaitCycles: number =
    config.getOptionalNumber('argocd.waitCycles') ?? 5;
  const argoSvc = new ArgoService(argoUserName, argoPassword, config);
  const argoApps = config
    .getConfigArray('argocd.appLocatorMethods')
    .filter(element => element.getString('type') === 'config');
  const appArray: Config[] = argoApps.reduce(
    (acc: Config[], argoApp: Config) =>      acc.concat(argoApp.getConfigArray('instances')),
    [],
  );
  const argoInstanceArray = appArray.map(instance => ({
    name: instance.getString('name'),
    url: instance.getString('url'),
    token: instance.getOptionalString('token'),
    username: instance.getOptionalString('username'),
    password: instance.getOptionalString('password'),
  }));
  router.get('/find/name/:argoAppName', async (request, response) => {
    const argoAppName = request.params.argoAppName;
    response.send(await argoSvc.findArgoApp({ name: argoAppName }));
  });
  router.get(
    '/argoInstance/:argoInstanceName/applications/name/:argoAppName',
    async (request, response) => {
      const argoInstanceName = request.params.argoInstanceName;
      const argoAppName = request.params.argoAppName;
      logger.info(`Getting info on ${argoAppName}`);
      logger.info(`Getting app ${argoAppName} on ${argoInstanceName}`);
      const matchedArgoInstance = argoInstanceArray.find(
        argoInstance => argoInstance.name === argoInstanceName,
      );
      if (matchedArgoInstance === undefined) {
        return response.status(500).send({
          status: 'failed',
          message: 'cannot find an argo instance to match this cluster',
        });
      }
      let token: string;
      if (!matchedArgoInstance.token) {
        token = await argoSvc.getArgoToken(matchedArgoInstance);
      } else {
        token = matchedArgoInstance.token;
      }
      const resp = await argoSvc.getArgoAppData(
        matchedArgoInstance.url,
        matchedArgoInstance.name,
        { name: argoAppName },
        token,
      );
      return response.send(resp);
    },
  );
  router.get('/find/selector/:argoAppSelector', async (request, response) => {
    const argoAppSelector = request.params.argoAppSelector;
    response.send(await argoSvc.findArgoApp({ selector: argoAppSelector }));
  });
  router.get(
    '/argoInstance/:argoInstanceName/applications/selector/:argoAppSelector',
    async (request, response) => {
      const argoInstanceName = request.params.argoInstanceName;
      const argoAppSelector = request.params.argoAppSelector;
      logger.info(
        `Getting apps for selector ${argoAppSelector} on ${argoInstanceName}`,
      );
      const matchedArgoInstance = argoInstanceArray.find(
        argoInstance => argoInstance.name === argoInstanceName,
      );
      if (matchedArgoInstance === undefined) {
        return response.status(500).send({
          status: 'failed',
          message: 'cannot find an argo instance to match this cluster',
        });
      }
      let token: string;
      if (!matchedArgoInstance.token) {
        token = await argoSvc.getArgoToken(matchedArgoInstance);
      } else {
        token = matchedArgoInstance.token;
      }
      const resp = await argoSvc.getArgoAppData(
        matchedArgoInstance.url,
        matchedArgoInstance.name,
        { selector: argoAppSelector },
        token,
      );
      return response.send(resp);
    },
  );
  router.post('/createArgo', async (request, response) => {
    const argoInstanceName = request.body.clusterName;
    const namespace = request.body.namespace;
    const projectName = request.body.projectName as string;
    const appName = request.body.appName as string;
    const labelValue = request.body.labelValue as string;
    const sourceRepo = request.body.sourceRepo;
    const sourcePath = request.body.sourcePath;
    const matchedArgoInstance = argoInstanceArray.find(
      argoInstance => argoInstance.name === argoInstanceName,
    );
    if (matchedArgoInstance === undefined) {
      return response.status(500).send({
        status: 'failed',
        message: 'cannot find an argo instance to match this cluster',
      });
    }
    let token: string;
    if (!matchedArgoInstance.token) {
      try {
        token = await argoSvc.getArgoToken(matchedArgoInstance);
      } catch (e: any) {
        return response.status(e.status || 500).send({
          status: e.status,
          message: e.message,
        });
      }
    } else {
      token = matchedArgoInstance.token;
    }

    try {
      await argoSvc.createArgoProject({
        baseUrl: matchedArgoInstance.url,
        argoToken: token,
        projectName,
        namespace,
        sourceRepo,
      });
    } catch (e: any) {
      logger.error(e);
      return response.status(e.status || 500).send({
        status: e.status,
        message: e.message || 'Failed to create argo project',
      });
    }

    try {
      await argoSvc.createArgoApplication({
        baseUrl: matchedArgoInstance.url,
        argoToken: token,
        projectName,
        appName,
        namespace,
        sourceRepo,
        sourcePath,
        labelValue,
      });
      return response.send({
        argoProjectName: projectName,
        argoAppName: appName,
        kubernetesNamespace: namespace,
      });
    } catch (e: any) {
      logger.error(e);
      return response.status(500).send({
        status: 500,
        message: e.message || 'Failed to create argo app',
      });
    }
  });
  router.post('/sync', async (request, response) => {
    const appSelector = request.body.appSelector;
    try {
      const argoSyncResp = await argoSvc.resyncAppOnAllArgos({ appSelector });
      return response.send(argoSyncResp);
    } catch (e: any) {
      return response.status(e.status || 500).send({
        status: e.status || 500,
        message: e.message || `Failed to sync your app, ${appSelector}.`,
      });
    }
  });
  router.delete(
    '/argoInstance/:argoInstanceName/applications/:argoAppName',
    async (request, response) => {
      const argoInstanceName: string = request.params.argoInstanceName;
      const argoAppName: string = request.params.argoAppName;
      logger.info(`Getting info on ${argoInstanceName} and ${argoAppName}`);
      const matchedArgoInstance = argoInstanceArray.find(
        argoInstance => argoInstance.name === argoInstanceName,
      );
      if (matchedArgoInstance === undefined) {
        return response.status(500).send({
          status: 'failed',
          message: 'cannot find an argo instance to match this cluster',
        });
      }
      let token: string;
      if (!matchedArgoInstance.token) {
        token = await argoSvc.getArgoToken(matchedArgoInstance);
      } else {
        token = matchedArgoInstance.token;
      }
      const argoDeleteProjectResp: Response = { 
        status: '',
        message: ''
      };
      const argoDeleteAppResp: Response = { 
        status: '',
        message: ''
      };
      let countinueToDeleteProject: boolean = true
      let isAppexist: boolean = true
      try {
        const deleteAppResp = await argoSvc.deleteApp({
          baseUrl: matchedArgoInstance.url,
          argoApplicationName: argoAppName,
          argoToken: token,
        });
        if (deleteAppResp === false) {
          countinueToDeleteProject = false
          argoDeleteAppResp.status = "failed";
          argoDeleteAppResp.message = 'error with deleteing argo app';
        }
      } catch (e: any) {  
        if (typeof e.message === 'string') {
          isAppexist = false;
          countinueToDeleteProject = true
          argoDeleteAppResp.status = "failed";
          argoDeleteAppResp.message = e.message;
        }
      }
      let isAppPendingDelete: boolean = false
      if (isAppexist) {
        for (let attempts = 0; attempts < argoWaitCycles; attempts++) {
          try {
            const argoApp = await argoSvc.getArgoAppData(
              matchedArgoInstance.url,
              matchedArgoInstance.name,
              { name: argoAppName },
              token,
            );
            isAppPendingDelete = 'metadata' in argoApp;
            if (!isAppPendingDelete) { 
              argoDeleteAppResp.status = "success"
              argoDeleteAppResp.message = 'application is deleted successfully'; 
              break;
            };
           await timer(5000);
          } catch (e: any) { 
            if (attempts === argoWaitCycles){
              argoDeleteAppResp.status = "failed";
              argoDeleteAppResp.message = "error getting argo app data";
          }
            continue;
          }
        }
      }
      try {
        if (isAppPendingDelete && isAppexist) {
            argoDeleteAppResp.status = "failed"
            argoDeleteAppResp.message = 'application pending delete';
            argoDeleteProjectResp.status = 'failed';
            argoDeleteProjectResp.message = 'skipping project deletion due to app deletion pending';
        } else if (countinueToDeleteProject) {
            await argoSvc.deleteProject({
              baseUrl: matchedArgoInstance.url,
              argoProjectName: argoAppName,
              argoToken: token,          
          });
          argoDeleteProjectResp.status = 'success';
          argoDeleteProjectResp.message = 'project is deleted successfully';
        } else {
          argoDeleteProjectResp.status = 'failed';
          argoDeleteProjectResp.message = 'skipping project deletion due to erro deleting argo app';
        } 
      } catch (e: any) {
        if (typeof e.message === 'string') {
          argoDeleteProjectResp.status = "failed";
          argoDeleteProjectResp.message = e.message;
        } else {
          argoDeleteProjectResp.status = "failed";
          argoDeleteProjectResp.message = 'error with deleteing argo project';
        }
      }
      return response.send({
        argoDeleteAppResp: argoDeleteAppResp,
        argoDeleteProjectResp: argoDeleteProjectResp,
      });
    },
  );
  
  router.use(errorHandler());
  return Promise.resolve(router);
}