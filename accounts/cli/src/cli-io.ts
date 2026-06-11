export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}
