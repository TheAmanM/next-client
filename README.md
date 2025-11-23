# Next Client

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/next-client.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=next-client)

A free and open-source VS Code extension to help Next.js developers avoid security bugs by clearly highlighting all "use client" components and their usages.

## The Problem

In Next.js, passing data from server components to client components can inadvertently lead to security vulnerabilities if not handled carefully. It's easy to lose track of which components are client-side, especially in larger projects. This extension helps you stay aware of the client/server boundary.

## Features

This extension scans your workspace to build a module graph and identifies all components that are client-side, either directly (with a `"use client";` directive) or indirectly (by importing a client component).

- **Highlights Client Component Definitions**: If a file is determined to be a client component, all React component definitions within that file are highlighted.
- **Highlights Client Component Usages**: When you use a client component in another file (server or client), the JSX tag for that component is highlighted.
- **Automatic & Real-time**: The highlighting is applied automatically and updates as you type or change files.
- **Customizable Styling**: You can customize the highlight colors to fit your theme.

![feature-gif](https://raw.githubusercontent.com/your-repo/next-client/main/images/feature.gif)

> (Note: You will need to create and add a feature GIF/image to showcase the extension)

## Requirements

- Visual Studio Code version `1.101.0` or newer.
- A Next.js project.

## Installation

1.  Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=next-client).
2.  Reload VS Code.
3.  The extension will automatically activate when you open a JavaScript or TypeScript file.

## Extension Settings

You can customize the appearance of the highlights by adding the following settings to your `settings.json` file:

- `nextClient.styling.backgroundColor`: The background color for the highlight. It's best to use an `rgba()` value for transparency.
  - _Default_: `"rgba(255, 0, 0, 0.2)"`
- `nextClient.styling.color`: The text color for the highlight, which is more prominent in light themes.
  - _Default_: `"rgba(255, 0, 0, 0.9)"`
- `nextClient.styling.darkColor`: The text color for the highlight on dark themes.
  - _Default_: `"rgba(255, 100, 100, 0.9)"`

## Known Issues

There are no known issues at this time. If you find a bug, please [open an issue](https://github.com/your-repo/next-client/issues).

## Release Notes

### 0.0.1

- Initial release of Next Client.

---

## Contributing

Contributions are welcome! Please feel free to open an issue or submit a pull request.

## License

This extension is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

**Enjoy!**
