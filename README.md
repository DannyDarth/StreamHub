StreamHub
===
[![Latest release][badge-release]][Releases] [![Build status][badge-actions]][Github-actions] [![License][badge-license]](LICENSE)

**A desktop browser for [Twitch][Twitch] and [Kick][Kick] streams, built on [Streamlink][Streamlink].**

StreamHub is a modified version of [Streamlink Twitch GUI][Upstream]. Mainly for personal use, but if anyone wants to improve or add features, you're more than welcome.

<img width="903" height="599" alt="StreamHub screenshot" src="https://github.com/user-attachments/assets/5561e81b-d98c-423c-942b-fac619c7ecdc" />

Looking for the iPhone app? It lives in its own repository: [StreamHub-iOS][iOS].


## ℹ️ Description

A graphical user interface on top of the [Streamlink][Streamlink] command line interface. Streams play in the video player of your choice instead of the browser, which keeps playback smooth and light on CPU and battery.

StreamHub is an [NW.js][NW.js] application written in JavaScript ([EmberJS][EmberJS]), HTML ([Handlebars][Handlebars]) and CSS ([LessCSS][LessCSS]).


## 👍 Features

* Twitch and Kick: browse, follow and watch streams from both
* Watch streams in the video player of your choice via Streamlink
* Watch multiple streams at once
* Browse streams by popularity, game, channel or team
* Access your followed streams and channels
* Filter streams by channel or broadcasting language
* Desktop notifications when new streams start
* Join the chat using customizable chat applications
* Rich settings with lots of customizations and presets, plus per-channel settings
* Multiple languages, light and dark themes, customizable hotkeys
* Command line parameters for automation


## 📦 Download

Get the Windows installer from the [Releases][Releases] page. StreamHub checks that page for updates.

StreamHub is a graphical interface for **Streamlink**, so [Streamlink][Streamlink] has to be installed for streams to launch.


## 🔨 Build

Install [Git][Git], [Node.js][Node.js] (20 or newer) and [Yarn][yarn], then:

```bash
git clone https://github.com/DannyDarth/StreamHub.git
cd StreamHub
yarn install
yarn run grunt release
```

The built application ends up in `build/releases`. Run the tests with `yarn run grunt test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for more detail.


## 🙏 Credits

StreamHub is built on [Streamlink Twitch GUI][Upstream] by Sebastian Meyer ([@bastimeyer](https://github.com/bastimeyer)). If you'd like to support the original project, he accepts [GitHub Sponsors](https://github.com/users/bastimeyer/sponsorship) and [PayPal](https://paypal.me/bastimeyer123).


## License

StreamHub is released under the [MIT License](LICENSE). It is based on Streamlink Twitch GUI by Sebastian Meyer, also MIT-licensed; the original copyright notice is kept in [LICENSE](LICENSE).


  [Releases]: https://github.com/DannyDarth/StreamHub/releases "StreamHub releases"
  [Github-actions]: https://github.com/DannyDarth/StreamHub/actions/workflows/main.yml "Build status"
  [iOS]: https://github.com/DannyDarth/StreamHub-iOS "StreamHub-iOS"
  [Upstream]: https://github.com/streamlink/streamlink-twitch-gui "Streamlink Twitch GUI"
  [Streamlink]: https://streamlink.github.io/ "Streamlink"
  [Twitch]: https://twitch.tv "Twitch"
  [Kick]: https://kick.com "Kick"
  [NW.js]: https://github.com/nwjs/nw.js "NW.js"
  [EmberJS]: https://emberjs.com/ "EmberJS"
  [Handlebars]: https://handlebarsjs.com/ "Handlebars.js"
  [LessCSS]: https://lesscss.org/ "LessCSS"
  [Git]: https://git-scm.com "Git"
  [Node.js]: https://nodejs.org "Node.js"
  [yarn]: https://classic.yarnpkg.com/lang/en/ "Yarn"
  [badge-release]: https://img.shields.io/github/v/release/DannyDarth/StreamHub?style=flat-square "Latest release"
  [badge-actions]: https://img.shields.io/github/actions/workflow/status/DannyDarth/StreamHub/main.yml?branch=master&event=push&style=flat-square "Build status"
  [badge-license]: https://img.shields.io/github/license/DannyDarth/StreamHub?style=flat-square "License"
