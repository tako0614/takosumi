import { Command } from "../command.ts";

/**
 * Shell completion generator.
 *
 * Replaces cliffy's bundled `CompletionsCommand`. commander has no built-in
 * completion generator, so we ship an explicit `completions <shell>` command
 * (bash / zsh / fish) that emits a minimal completion script naming the
 * top-level subcommands. Dynamic value completion (e.g. installed app names) is
 * left as a follow-up; this matches the prior surface of
 * `takosumi completions <shell>`.
 */
export function createCompletionsCommand(program: Command): Command {
  const command = new Command("completions")
    .description("Generate shell completions");

  const programName = () => program.name() || "takosumi";
  const subcommandNames = () =>
    program.commands
      .map((c) => c.name())
      .filter((n) => n !== "completions" && n !== "help");

  for (const shell of ["bash", "zsh", "fish"] as const) {
    command.command(shell)
      .description(`Generate the ${shell} completion script`)
      .action(() => {
        console.log(
          completionScript(shell, programName(), subcommandNames()),
        );
      });
  }

  return command;
}

function completionScript(
  shell: "bash" | "zsh" | "fish",
  name: string,
  commands: string[],
): string {
  const joined = commands.join(" ");
  switch (shell) {
    case "bash":
      return [
        `# ${name} bash completion`,
        `_${name}_complete() {`,
        `  COMPREPLY=( $(compgen -W "${joined}" -- "\${COMP_WORDS[COMP_CWORD]}") )`,
        `}`,
        `complete -F _${name}_complete ${name}`,
      ].join("\n");
    case "zsh":
      return [
        `#compdef ${name}`,
        `# ${name} zsh completion`,
        `_${name}() { compadd ${joined} }`,
        `compdef _${name} ${name}`,
      ].join("\n");
    case "fish":
      return [
        `# ${name} fish completion`,
        ...commands.map((c) =>
          `complete -c ${name} -n "__fish_use_subcommand" -a "${c}"`
        ),
      ].join("\n");
  }
}
