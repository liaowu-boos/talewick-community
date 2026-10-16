# Local independent-review transport check

This synthetic fixture answers the model client's chat-completions HTTP contract using the review packet's example response. It checks transport, isolation, persistence, and protocol validation, not semantic judgment. It contains no manuscript corpus or captured provider responses. No owner-workspace mock is needed for this project-specific example generator.

With Postman CLI 1.73+ and the product dependencies installed, run from the repository root:

```sh
postman simulation run tools/postman/simulations/independent-review.sim.yaml --port 14931 --output ndjson
```

In another terminal:

```sh
node tools/independent-review-smoke.mjs
```

The application runs for real against the loopback simulation. It checks two single-draft reading stages, seven no-change comparison stages, idempotent submission, conflicting input, and Full15 availability. Inspect the simulation request events to confirm traffic. Stop the simulation after testing. There is no deployment or workspace publication step.
