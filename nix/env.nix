{ pkgs, packages }:
with packages;
{
  dev = [
    git
  ];

  lint = [
    treefmt
  ];

  main = [
  ];

  system = [
    atomiutils
  ];
}
