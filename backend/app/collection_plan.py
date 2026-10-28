"""磁力合集逐文件识别与整理，保留原始路径供 qB 重命名。"""

import re
from pathlib import PurePosixPath, PureWindowsPath

from .download_queue import SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS, build_plan, subtitle_language
from .release_parser import parse_release_title

EXTRAS = re.compile(
    r"(?i)(?:^|[\W_])(?:NCOP\d*|NCED\d*|OP\d*|ED\d*|menu|menus|tokuten|"
    r"PV\d*|CM\d*|SP\d*|OVA|OAD|specials?|extras?|opening|ending)(?:$|[\W_])"
    r"|特典|映像特典|特典映像|菜单|花絮|预告|映像特典"
)


def collection_title(raw):
    parsed = parse_release_title(raw)
    title = parsed.title or raw
    # [字幕组][作品名][01-24] 形式的标题也能用于搜索。
    if title == raw or not parsed.title:
        brackets = re.findall(r"\[([^\]]+)\]", raw)
        if len(brackets) > 1:
            title = brackets[1]
    season = parsed.season or 1
    match = re.search(r"(?i)(?:\s+(?:Season|S)|第)(\d{1,2})(?:季|期)?$|\s+(\d{1,2})$", title)
    if match:
        season = int(match.group(1) or match.group(2))
        title = title[: match.start()].strip()
    return title.strip(), season


def is_extra(path):
    return bool(EXTRAS.search(str(path)))


def build_collection_plan(files, title, season, release):
    paths = [PurePosixPath(str(f["name"]).replace("\\", "/")) for f in files]
    if any(PureWindowsPath(p).drive for p in paths):
        raise ValueError("种子包含无效文件路径")
    edits = {}
    for edit in release.collection_file_overrides:
        # 历史记录中的文件名仅供兼容读取，不参与当前规范命名。
        if edit.episode is None:
            continue
        path = PurePosixPath(edit.path)
        if path in edits:
            raise ValueError("同一文件不能重复修改")
        if path not in paths:
            raise ValueError("下载器文件列表已变化，请重新解析磁力")
        if path.suffix.lower() not in VIDEO_EXTENSIONS or is_extra(path):
            raise ValueError("只能修改正片视频的集数")
        edits[path] = edit
    # 伴随字幕单独匹配；其他非正片文件不下载。
    overrides = {
        str(p): None for p in paths if p.suffix.lower() not in VIDEO_EXTENSIONS or is_extra(p)
    }
    episodes = {}
    for path in paths:
        if path.suffix.lower() in VIDEO_EXTENSIONS and not is_extra(path):
            parsed = parse_release_title(path.stem)
            edit = edits.get(path)
            manual_episode = edit.episode if edit else None
            episode = manual_episode if manual_episode is not None else parsed.episode_start
            if episode is None or (manual_episode is None and parsed.release_kind != "single"):
                raise ValueError(f"无法确定视频集数：{path.name}")
            episodes[path] = episode
            if edit is not None:
                overrides[str(path)] = episode
    plan = build_plan(files, title, season, release, overrides)
    wrapper = plan["wrapper"]

    def normalized(path):
        return str(PurePosixPath(plan["season_folder"], *path.parts[1:])) if wrapper else str(path)

    targets = {entry["old"]: entry["new"] for entry in plan["files"]}
    videos = [p for p in paths if normalized(p) in targets]
    plan["episodes"] = [episodes[path] for path in videos]
    skipped = set(plan["skip_file_ids"])
    used = {entry["new"].casefold() for entry in plan["files"]}
    for index, (file, path) in enumerate(zip(files, paths, strict=True)):
        if path.suffix.lower() not in SUBTITLE_EXTENSIONS:
            continue
        matches = [
            p
            for p in videos
            if path.parent == p.parent
            and (
                path.stem.casefold() == p.stem.casefold()
                or path.stem.casefold().startswith(p.stem.casefold() + ".")
            )
        ]
        if len(matches) != 1:
            continue
        video = matches[0]
        suffix = path.stem[len(video.stem) :]
        languages = subtitle_language(path)
        if languages == {"hans"}:
            suffix = ".zh-Hans"
        elif languages == {"hant"}:
            suffix = ".zh-Hant"
        target = (
            str(PurePosixPath(targets[normalized(video)]).with_suffix("")) + suffix + path.suffix
        )
        if target.casefold() in used:
            raise ValueError(f"字幕重命名后文件冲突：{target}")
        used.add(target.casefold())
        skipped.discard(int(file.get("index", index)))
        plan["files"].append({"old": normalized(path), "new": target})
    original_names = {normalized(path).casefold() for path in paths}
    for entry in plan["files"]:
        if (
            entry["new"].casefold() in original_names
            and entry["new"].casefold() != entry["old"].casefold()
        ):
            raise ValueError("整理后的文件名与另一原始文件冲突，请检查集数")
    plan["skip_file_ids"] = sorted(skipped)
    return plan
