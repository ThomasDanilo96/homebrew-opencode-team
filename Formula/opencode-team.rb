class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.7.tar.gz"
  sha256 "73d5c9a997899afc3cb725e58b0e0b7146ea74c375a13fa5e8719c24e5721320"
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
      exec "#{opt_prefix}/libexec/bin/opencode-team" "$@"
    EOS
    chmod 0755, bin/"opencode-team"
    (bin/"opencode-daily-team").write <<~EOS
      #!/bin/bash
      export PATH="#{formula_opt_bin("node@22")}:$PATH"
      exec "#{opt_prefix}/libexec/bin/opencode-daily-team" "$@"
    EOS
    chmod 0755, bin/"opencode-daily-team"
  end

  test do
    assert_match "OpenCode Team 0.1.7", shell_output("#{bin}/opencode-team version")
    assert_match "opencode-team start", shell_output("#{bin}/opencode-team --help")
  end
end
