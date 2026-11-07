declare module "cld3-asm" {
  export function create(): Promise<{
    identify(text: string): { language: string; probability: number };
  }>;
}
