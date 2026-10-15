import type { DataServices } from '../services';
import { registerAiHandlers } from './ai';
import { createDataServices } from './data';
import { registerFileHandlers } from './files';
import { installRouter, router } from './router';

export function registerIpc(): DataServices {
  installRouter();
  registerFileHandlers(router);
  const services = createDataServices(router);
  registerAiHandlers(router, services);
  return services;
}

export { router };
