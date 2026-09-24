# SoftEX web prototype

A responsive, accessible first implementation of the SoftEX unified workspace home screen. It turns the product brief into a working front-end prototype with daily priorities, projects, meetings, and recent activity.

## Run locally

The prototype has no build-time dependencies. Serve the repository with any static web server:

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## Technology

- Semantic HTML for a durable, accessible document structure
- Modern CSS (grid, custom properties, responsive breakpoints) for the interface
- Dependency-free JavaScript for the initial interactions

This deliberately lightweight foundation makes the concept immediately testable. Once workflows are validated, it can be migrated into a TypeScript component application backed by the services described in the product documentation.
