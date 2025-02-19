"use strict";

const path = require("path");
const WatchedDir = require("broccoli-source").WatchedDir;
const Funnel = require("broccoli-funnel");
const mergeTrees = require("broccoli-merge-trees");
const fs = require("fs");
const concat = require("broccoli-concat");
const RawHandlebarsCompiler = require("discourse-hbr/raw-handlebars-compiler");

function fixLegacyExtensions(tree) {
  return new Funnel(tree, {
    getDestinationPath: function (relativePath) {
      if (relativePath.endsWith(".es6")) {
        return relativePath.slice(0, -4);
      } else if (relativePath.endsWith(".raw.hbs")) {
        return relativePath.replace(".raw.hbs", ".hbr");
      }
      return relativePath;
    },
  });
}

const COLOCATED_CONNECTOR_REGEX =
  /^(?<prefix>.*)\/connectors\/(?<outlet>[^\/]+)\/(?<name>[^\/\.]+)\.(?<extension>.+)$/;

// Having connector templates and js in the same directory causes a clash
// when outputting es6 modules. This shim separates colocated connectors
// into separate js / template locations.
function unColocateConnectors(tree) {
  return new Funnel(tree, {
    getDestinationPath: function (relativePath) {
      const match = relativePath.match(COLOCATED_CONNECTOR_REGEX);
      if (
        match &&
        match.groups.extension === "hbs" &&
        !match.groups.prefix.endsWith("/templates")
      ) {
        const { prefix, outlet, name } = match.groups;
        return `${prefix}/templates/connectors/${outlet}/${name}.hbs`;
      }
      if (
        match &&
        match.groups.extension === "js" &&
        match.groups.prefix.endsWith("/templates")
      ) {
        // Some plugins are colocating connector JS under `/templates`
        const { prefix, outlet, name } = match.groups;
        const newPrefix = prefix.slice(0, -"/templates".length);
        return `${newPrefix}/connectors/${outlet}/${name}.js`;
      }
      return relativePath;
    },
  });
}

function namespaceModules(tree, pluginDirectoryName) {
  return new Funnel(tree, {
    getDestinationPath: function (relativePath) {
      return `discourse/plugins/${pluginDirectoryName}/${relativePath}`;
    },
  });
}

module.exports = {
  name: require("./package").name,

  pluginInfos() {
    const root = path.resolve("../../../../plugins");
    const pluginDirectories = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (dirent) =>
          (dirent.isDirectory() || dirent.isSymbolicLink()) &&
          !dirent.name.startsWith(".")
      );

    return pluginDirectories.map((directory) => {
      const name = directory.name;
      const jsDirectory = path.resolve(root, name, "assets/javascripts");
      const adminJsDirectory = path.resolve(
        root,
        name,
        "admin/assets/javascripts"
      );
      const testDirectory = path.resolve(root, name, "test/javascripts");
      const hasJs = fs.existsSync(jsDirectory);
      const hasAdminJs = fs.existsSync(adminJsDirectory);
      const hasTests = fs.existsSync(testDirectory);
      return {
        name,
        jsDirectory,
        adminJsDirectory,
        testDirectory,
        hasJs,
        hasAdminJs,
        hasTests,
      };
    });
  },

  generatePluginsTree() {
    const appTree = this._generatePluginAppTree();
    const testTree = this._generatePluginTestTree();
    const adminTree = this._generatePluginAdminTree();
    return mergeTrees([appTree, testTree, adminTree]);
  },

  _generatePluginAppTree() {
    const trees = this.pluginInfos()
      .filter((p) => p.hasJs)
      .map(({ name, jsDirectory }) =>
        this._buildAppTree({
          directory: jsDirectory,
          pluginName: name,
          outputFile: `assets/plugins/${name}.js`,
        })
      );
    return mergeTrees(trees);
  },

  _generatePluginAdminTree() {
    const trees = this.pluginInfos()
      .filter((p) => p.hasAdminJs)
      .map(({ name, adminJsDirectory }) =>
        this._buildAppTree({
          directory: adminJsDirectory,
          pluginName: name,
          outputFile: `assets/plugins/${name}_admin.js`,
        })
      );
    return mergeTrees(trees);
  },

  _buildAppTree({ directory, pluginName, outputFile }) {
    let tree = new WatchedDir(directory);

    tree = fixLegacyExtensions(tree);
    tree = unColocateConnectors(tree);
    tree = namespaceModules(tree, pluginName);

    tree = RawHandlebarsCompiler(tree);
    tree = this.compileTemplates(tree);

    tree = this.processedAddonJsFiles(tree);

    return concat(mergeTrees([tree]), {
      inputFiles: ["**/*.js"],
      outputFile,
      allowNone: true,
    });
  },

  _generatePluginTestTree() {
    const trees = this.pluginInfos()
      .filter((p) => p.hasTests)
      .map(({ name, testDirectory }) => {
        let tree = new WatchedDir(testDirectory);

        tree = fixLegacyExtensions(tree);
        tree = namespaceModules(tree, name);
        tree = this.processedAddonJsFiles(tree);

        return concat(mergeTrees([tree]), {
          inputFiles: ["**/*.js"],
          outputFile: `assets/plugins/test/${name}_tests.js`,
          allowNone: true,
        });
      });
    return mergeTrees(trees);
  },

  shouldCompileTemplates() {
    // The base Addon implementation checks for template
    // files in the addon directories. We need to override that
    // check so that the template compiler always runs.
    return true;
  },

  treeFor() {
    // This addon doesn't contribute any 'real' trees to the app
    return;
  },
};
