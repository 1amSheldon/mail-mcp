class MailMcp < Formula
  desc "MCP server for AI-powered email access via IMAP and SMTP"
  homepage "https://github.com/honest-magic/mail-mcp"
  url "https://registry.npmjs.org/@honest-magic/mail-mcp/-/mail-mcp-1.1.0.tgz"
  sha256 "e5d12fce3ad3330228c84e3d814f74b1a20ff2f505db1fbd2c2939be4ae7023a"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      To get started, add your first email account:
        mail-mcp accounts add
    EOS
  end

  test do
    assert_predicate bin/"mail-mcp", :executable?
  end
end
