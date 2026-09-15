class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.1.tar.gz"
  sha256 "c1fc4ce29671f92c327bb68d90e917c5e5a78a07007f72b785c53ccf71739ff7"
  license "MIT"

  depends_on "anomalyco/tap/opencode"
  depends_on "git"
  depends_on "jq"
  depends_on "node@22"
  depends_on "python@3.14"
  depends_on "ripgrep"
  depends_on "tmux"
  depends_on "uv"

  def install
    libexec.install "bin", "core", "shared", "teams", "tests", "VERSION"
    (bin/"opencode-team").write <<~EOS
      #!/bin/bash
      export PATH="#{formula_opt_bin("node@22")}:$PATH"
      exec "#{libexec}/bin/opencode-team" "$@"
    EOS
    chmod 0755, bin/"opencode-team"
  end

  test do
    assert_match "OpenCode Team 0.1.1", shell_output("#{bin}/opencode-team version")
    assert_match "opencode-team start", shell_output("#{bin}/opencode-team --help")
  end
end
