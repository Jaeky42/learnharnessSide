# History and records: Models and agents: the fork's additions

## Research: one wrap-up request

### The research wrap-up, what was checked

- **Checked** with scripted model replies only, by the implementer and then by an independent verifier with a script of its own: each of the four ways and the quiet variant now ends in the wrap-up's brief; 16 tool calls make exactly 17 model calls; a tool call in the wrap-up reply never ran; a wrap-up reply without text gives the old failure and no second wrap-up; a run that ends with a brief makes no extra call; a caller without `wrapUp` is as before. Typecheck clean, lint with its one existing warning.
