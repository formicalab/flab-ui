# flab-ui documentation

How flab-ui is built, how each page works and how it is tested. For what flab-ui is and how to install it, see the
[README](../README.md).

- [Architecture](architecture.md): how the browser, uhttpd, rpcd and the plugins fit together, the repository layout,
  the security model and how configuration changes are made safely.
- [Frontend](frontend.md): browser requirements, boot and routing, the page contract, the core modules and the styling.
- [Backend](backend.md): the rpcd plugins, their ACL fragments, the shared ucode modules and the backend rules.
- [Pages](pages/README.md): what every page shows and edits, and how it works.
- [Package](package.md): the unmerged feed definition, what it installs, how to build it, the package script
  (build, deploy, remove, release), submission requirements and the license.
- [Development](development.md): how to add a page, implementation notes and coding conventions.
- [Testing](testing.md): the test suites, what each covers and how to run it.

Start with the [configuration-change limitations](architecture.md#configuration-change-limitations) before testing
network edits. Passing mock tests does not establish real-router rollback, connectivity or cross-board compatibility.
