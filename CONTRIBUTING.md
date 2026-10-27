# Contributing to VOX

Thank you for your interest in improving **VOX**!

## Development Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/yabets4/vox.git
   cd vox/vox
   ```

2. **Install Node Dependencies**:
   ```bash
   npm install
   ```

3. **Start Web Dev Server**:
   ```bash
   npm run dev
   ```

4. **Android Build (Capacitor)**:
   ```bash
   npm run build
   npx cap sync android
   cd android
   ./gradlew assembleDebug
   ```

## Pull Request Guidelines

- Test changes on both desktop web and mobile Android WebView before submitting.
- Keep commits atomic and descriptive.
- Adhere to the existing code structure and linting standards.

## License

By contributing to VOX, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
