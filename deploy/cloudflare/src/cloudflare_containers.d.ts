export declare class Container {
  defaultPort: number;
  requiredPorts: number[];
  sleepAfter: string;
  enableInternet: boolean;
  pingEndpoint: string;
  envVars: Record<string, string>;
}

export declare function getContainer(
  namespace: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  },
  name: string,
): { fetch(request: Request): Promise<Response> };
