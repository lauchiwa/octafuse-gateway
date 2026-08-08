'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { RouteStrategyDiagramKind } from '../route-strategy-meta';

type Props = {
	kind: RouteStrategyDiagramKind;
	/** Animate path when the card is selected or hovered. */
	active?: boolean;
	className?: string;
	/** Localized one-line caption drawn above the flow. */
	caption?: string;
};

function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		const sync = () => setReduced(mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	}, []);
	return reduced;
}

const VIEW_W = 220;
const VIEW_H = 112;
const TARGET_X = 158;

function SvgShell(props: {
	ariaLabel: string;
	children: ReactNode;
}) {
	return (
		<svg
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			className="h-[104px] w-full"
			role="img"
			aria-label={props.ariaLabel}
		>
			{props.children}
		</svg>
	);
}

function TargetBox(props: {
	y: number;
	label: string;
	hint?: string;
	picked?: boolean;
}) {
	const { y, label, hint, picked } = props;
	return (
		<>
			<rect
				x={TARGET_X}
				y={y - 9}
				width={34}
				height={18}
				rx={4}
				className={
					picked
						? 'fill-emerald-50 stroke-emerald-500'
						: 'fill-slate-50 stroke-slate-300'
				}
				strokeWidth={1.3}
			/>
			<text
				x={TARGET_X + 17}
				y={y + 4}
				textAnchor="middle"
				className="fill-slate-700"
				style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}
			>
				{label}
			</text>
			{hint ? (
				<text
					x={TARGET_X + 40}
					y={y + 3.5}
					className="fill-slate-500"
					style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace' }}
				>
					{hint}
				</text>
			) : null}
		</>
	);
}

function RequestNode(props: {
	x: number;
	y: number;
	label: string;
	accent?: boolean;
}) {
	const { x, y, label, accent } = props;
	return (
		<>
			<circle
				cx={x}
				cy={y}
				r={10}
				className={accent ? 'fill-indigo-50 stroke-indigo-400' : 'fill-slate-50 stroke-slate-400'}
				strokeWidth={1.4}
			/>
			<text
				x={x}
				y={y + 3.5}
				textAnchor="middle"
				className={accent ? 'fill-indigo-700' : 'fill-slate-600'}
				style={{ fontSize: 8.5, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}
			>
				{label}
			</text>
		</>
	);
}

function AnimatedDot(props: {
	path: string;
	active?: boolean;
	delayMs?: number;
	dur?: string;
}) {
	const { path, active, delayMs = 0, dur = '2s' } = props;
	if (!active) return null;
	return (
		<circle r={2.6} className="fill-indigo-500">
			<animateMotion
				path={path}
				begin={`${delayMs}ms`}
				dur={dur}
				repeatCount="indefinite"
				keyPoints="0;0;1;1"
				keyTimes="0;0.08;0.55;1"
				calcMode="linear"
			/>
			<animate
				attributeName="opacity"
				values="0;0;1;1;0;0"
				keyTimes="0;0.08;0.12;0.5;0.55;1"
				begin={`${delayMs}ms`}
				dur={dur}
				repeatCount="indefinite"
			/>
		</circle>
	);
}

/**
 * Affinity: different sticky keys (users) pin to different targets.
 * Shows "same key stays sticky" — not a global fixed primary.
 */
function AffinityDiagram({ active, caption }: { active?: boolean; caption?: string }) {
	const pathU1 = `M 34,34 C 88,34 120,34 ${TARGET_X - 2},34`;
	const pathU2 = `M 34,78 C 88,78 120,78 ${TARGET_X - 2},78`;
	return (
		<SvgShell ariaLabel="Affinity: same user key sticks to the same target">
			{caption ? (
				<text
					x={8}
					y={14}
					className="fill-slate-400"
					style={{ fontSize: 8.5, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
				>
					{caption}
				</text>
			) : null}
			{/* Paths */}
			<path
				d={pathU1}
				fill="none"
				strokeWidth={2.2}
				className="stroke-indigo-500"
				opacity={0.9}
			/>
			<path
				d={pathU2}
				fill="none"
				strokeWidth={2.2}
				className="stroke-violet-500"
				opacity={0.9}
			/>
			{/* Idle dashed alternatives */}
			<path
				d={`M 34,34 C 88,34 120,56 ${TARGET_X - 2},56`}
				fill="none"
				strokeWidth={1}
				strokeDasharray="3 3"
				className="stroke-slate-300"
			/>
			<path
				d={`M 34,78 C 88,78 120,56 ${TARGET_X - 2},56`}
				fill="none"
				strokeWidth={1}
				strokeDasharray="3 3"
				className="stroke-slate-300"
			/>
			<AnimatedDot path={pathU1} active={active} delayMs={0} />
			<AnimatedDot path={pathU2} active={active} delayMs={700} />
			<RequestNode x={24} y={34} label="U1" accent />
			<RequestNode x={24} y={78} label="U2" />
			<TargetBox y={34} label="T2" hint="sticky" picked />
			<TargetBox y={56} label="T1" />
			<TargetBox y={78} label="T3" hint="sticky" picked />
		</SvgShell>
	);
}

/**
 * Strict: every request uses the same weight-descending attempt order.
 */
function StrictDiagram({ active, caption }: { active?: boolean; caption?: string }) {
	const path1 = `M 40,56 C 90,56 120,28 ${TARGET_X - 2},28`;
	const path2 = `M 40,56 C 90,56 120,56 ${TARGET_X - 2},56`;
	const path3 = `M 40,56 C 90,56 120,84 ${TARGET_X - 2},84`;
	return (
		<SvgShell ariaLabel="Strict: all requests use the same numbered order">
			{caption ? (
				<text
					x={8}
					y={14}
					className="fill-slate-400"
					style={{ fontSize: 8.5, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
				>
					{caption}
				</text>
			) : null}
			<path d={path1} fill="none" strokeWidth={2.2} className="stroke-indigo-500" opacity={0.9} />
			<path
				d={path2}
				fill="none"
				strokeWidth={1.3}
				strokeDasharray="3 3"
				className="stroke-slate-400"
			/>
			<path
				d={path3}
				fill="none"
				strokeWidth={1.1}
				strokeDasharray="3 3"
				className="stroke-slate-300"
			/>
			{/* Vertical failover chain */}
			<path
				d={`M ${TARGET_X + 17},37 V 47`}
				fill="none"
				strokeWidth={1.2}
				className="stroke-slate-400"
				markerEnd="url(#strict-arrow)"
			/>
			<path
				d={`M ${TARGET_X + 17},65 V 75`}
				fill="none"
				strokeWidth={1.2}
				className="stroke-slate-400"
			/>
			<defs>
				<marker id="strict-arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
					<path d="M0,0 L6,3 L0,6 Z" className="fill-slate-400" />
				</marker>
			</defs>
			<AnimatedDot path={path1} active={active} />
			<RequestNode x={28} y={56} label="req" accent />
			<TargetBox y={28} label="T1" hint="#1" picked />
			<TargetBox y={56} label="T2" hint="#2" />
			<TargetBox y={84} label="T3" hint="#3" />
		</SvgShell>
	);
}

function WeightedRandomDiagram({ active, caption }: { active?: boolean; caption?: string }) {
	const paths = [
		{ d: `M 40,56 C 90,56 120,28 ${TARGET_X - 2},28`, w: 2.6, pct: '60%', delay: 0 },
		{ d: `M 40,56 C 90,56 120,56 ${TARGET_X - 2},56`, w: 1.8, pct: '30%', delay: 500 },
		{ d: `M 40,56 C 90,56 120,84 ${TARGET_X - 2},84`, w: 1.1, pct: '10%', delay: 1000 },
	];
	return (
		<SvgShell ariaLabel="Weighted random: pick by weight">
			{caption ? (
				<text
					x={8}
					y={14}
					className="fill-slate-400"
					style={{ fontSize: 8.5, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
				>
					{caption}
				</text>
			) : null}
			{paths.map((p) => (
				<path
					key={p.pct}
					d={p.d}
					fill="none"
					strokeWidth={p.w}
					className="stroke-indigo-500"
					opacity={0.55 + p.w * 0.12}
				/>
			))}
			{paths.map((p) => (
				<AnimatedDot key={`dot-${p.pct}`} path={p.d} active={active} delayMs={p.delay} />
			))}
			<RequestNode x={28} y={56} label="req" accent />
			<TargetBox y={28} label="T1" hint="60%" picked />
			<TargetBox y={56} label="T2" hint="30%" picked />
			<TargetBox y={84} label="T3" hint="10%" picked />
		</SvgShell>
	);
}

function RoundRobinDiagram({ active, caption }: { active?: boolean; caption?: string }) {
	const paths = [
		{ d: `M 40,56 C 90,56 120,28 ${TARGET_X - 2},28`, delay: 0 },
		{ d: `M 40,56 C 90,56 120,56 ${TARGET_X - 2},56`, delay: 600 },
		{ d: `M 40,56 C 90,56 120,84 ${TARGET_X - 2},84`, delay: 1200 },
	];
	return (
		<SvgShell ariaLabel="Round robin: rotate first choice">
			{caption ? (
				<text
					x={8}
					y={14}
					className="fill-slate-400"
					style={{ fontSize: 8.5, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
				>
					{caption}
				</text>
			) : null}
			{paths.map((p, i) => (
				<path
					key={i}
					d={p.d}
					fill="none"
					strokeWidth={1.7}
					className="stroke-indigo-500"
					opacity={0.75}
				/>
			))}
			{/* Cycle hint between targets */}
			<path
				d={`M ${TARGET_X + 17},37 C ${TARGET_X + 48},37 ${TARGET_X + 48},56 ${TARGET_X + 37},56`}
				fill="none"
				strokeWidth={1.2}
				className="stroke-emerald-500"
				opacity={0.8}
			/>
			<path
				d={`M ${TARGET_X + 17},65 C ${TARGET_X + 48},65 ${TARGET_X + 48},84 ${TARGET_X + 37},84`}
				fill="none"
				strokeWidth={1.2}
				className="stroke-emerald-500"
				opacity={0.8}
			/>
			{paths.map((p, i) => (
				<AnimatedDot key={i} path={p.d} active={active} delayMs={p.delay} dur="2.4s" />
			))}
			<RequestNode x={28} y={56} label="req" accent />
			<TargetBox y={28} label="T1" hint="↻" picked />
			<TargetBox y={56} label="T2" hint="↻" picked />
			<TargetBox y={84} label="T3" hint="↻" picked />
		</SvgShell>
	);
}

export function RouteStrategyDiagram(props: Props) {
	const { kind, active, className, caption } = props;
	const reducedMotion = usePrefersReducedMotion();
	const animate = Boolean(active) && !reducedMotion;
	const wrap = className ?? 'text-slate-700';

	return (
		<div
			className={`overflow-hidden rounded-md bg-slate-50/80 ring-1 ring-inset ring-slate-200/80 ${wrap}`}
		>
			{kind === 'hash_affinity' ? <AffinityDiagram active={animate} caption={caption} /> : null}
			{kind === 'weight_priority' ? <StrictDiagram active={animate} caption={caption} /> : null}
			{kind === 'weighted_random' ? (
				<WeightedRandomDiagram active={animate} caption={caption} />
			) : null}
			{kind === 'weighted_round_robin' ? <RoundRobinDiagram active={animate} caption={caption} /> : null}
		</div>
	);
}
