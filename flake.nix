{
  description = "Self-hosted OMP profile sync server";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      source = builtins.path { path = ./src; name = "omp-sync-server-src"; };
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.writeShellApplication {
            name = "omp-sync-server";
            text = ''
              if [ "$#" -eq 0 ]; then
                set -- serve
              fi
              exec ${pkgs.bun}/bin/bun ${source}/main.ts "$@"
            '';
          };
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/omp-sync-server";
        };
      });

      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.bun pkgs.git pkgs.typescript ];
          };
        });
    };
}
