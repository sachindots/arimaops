// The agent-forms renderer lists zod 3 as both a dependency and a peer; as a peer it would take the app's zod 4.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "@a2ui/react" && pkg.peerDependencies) delete pkg.peerDependencies.zod;
      return pkg;
    },
  },
};
