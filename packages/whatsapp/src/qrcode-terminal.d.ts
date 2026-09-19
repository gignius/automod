declare module "qrcode-terminal" {
  const qrcodeTerminal: { generate(input: string, options: { small?: boolean }, callback: (output: string) => void): void };
  export default qrcodeTerminal;
}
